// Agents run a turn at a time: each prompt starts the CLI without a terminal, what it prints becomes the session's
// transcript (a file of entries, one per line, which the session screens read like Claude's own), and the next
// prompt resumes the same conversation. A prompt sent while a turn runs waits for it.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentAccess, AgentEvent, Entry } from "@cockpit/shared";
import { getSession } from "../claude/sessions.ts";
import { paths } from "../config.ts";
import { db } from "../db.ts";
import { emit } from "../events.ts";
import { notify } from "../notify.ts";
import { spawnLines } from "../util.ts";
import { agentBin, agentOff, agentProvider } from "./index.ts";

export interface AgentRow {
  id: string;
  agent: string;
  model: string | null;
  cwd: string;
  access: AgentAccess;
  native_id: string | null;
  title: string | null;
  status: "busy" | "idle" | "ended";
  file: string;
  tokens_in: number;
  tokens_out: number;
  cost: number | null;
  error: string | null;
  started_at: number;
  updated_at: number;
}

const dir = join(paths.data, "agents");
const get = db.prepare<[string], AgentRow>("select * from agent_sessions where id = ?");
export const agentRow = (id: string) => get.get(id);
export const agentRows = () => db.prepare<[], AgentRow>("select * from agent_sessions order by updated_at desc limit 300").all();
const byNative = db.prepare<[string], AgentRow>("select * from agent_sessions where native_id = ?");
export const agentOfNative = (nativeId: string) => byNative.get(nativeId);

function update(id: string, patch: Partial<AgentRow>) {
  const keys = Object.keys(patch);
  db.prepare(`update agent_sessions set ${keys.map((k) => `${k} = @${k}, `).join("")}updated_at = @now where id = @id`).run({ ...patch, id, now: Date.now() });
}

const running = new Map<string, { kill(): void }>();
const waiting = new Map<string, string[]>();
let seq = 0;

function write(row: AgentRow, e: Omit<Entry, "id" | "ts"> & Record<string, unknown>) {
  appendFileSync(row.file, `${JSON.stringify({ ...e, id: `${Date.now().toString(36)}-${++seq}`, ts: new Date().toISOString() })}\n`);
}

// Where the repo keeps its git data, which a sandboxed agent may otherwise only read, so it couldn't commit: the
// .git folder above cwd, or for a worktree both its own folder in the main checkout's .git (its index and HEAD)
// and that .git itself (the objects and branches), each named, since Codex keeps a worktree's own folder read-only
// unless it's given by name
function gitDirs(cwd: string): string[] {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    try {
      if (statSync(dotGit).isDirectory()) return [dotGit];
      const linked = resolve(dir, readFileSync(dotGit, "utf8").replace(/^gitdir:\s*/, "").trim());
      return [linked, resolve(dirname(linked), "..")];
    } catch {}
    if (dirname(dir) === dir) return [];
  }
}

export interface NewAgentSession {
  agent: string;
  cwd: string;
  prompt: string;
  model?: string;
  title?: string;
  access?: AgentAccess;
}

export function startAgent(o: NewAgentSession) {
  const p = agentProvider(o.agent);
  if (!p) throw Object.assign(new Error(`No agent called ${o.agent}`), { status: 400 });
  if (agentOff(p.id)) throw Object.assign(new Error(`${p.name} is turned off in Settings → Board and automation`), { status: 400 });
  if (!existsSync(o.cwd)) throw Object.assign(new Error(`${o.cwd} doesn't exist`), { status: 400 });
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    "insert into agent_sessions (id, agent, model, cwd, access, title, status, file, started_at, updated_at) values (?, ?, ?, ?, ?, ?, 'busy', ?, ?, ?)",
  ).run(id, p.id, o.model || null, o.cwd, o.access ?? "sandbox", o.title ?? o.prompt.split("\n")[0].slice(0, 80), join(dir, `${id}.jsonl`), now, now);
  emit("session.started", getSession(id));
  turn(id, o.prompt);
  return id;
}

// false when there's no such session
export function sendAgent(id: string, text: string) {
  const row = agentRow(id);
  if (!row) return false;
  if (running.has(id)) waiting.set(id, [...(waiting.get(id) ?? []), text]);
  else turn(id, text);
  return true;
}

// stops the turn that's running; the conversation can go on with another prompt
export function stopAgent(id: string) {
  waiting.delete(id);
  running.get(id)?.kill();
}

// done with: it leaves the live lists
export function closeAgent(id: string) {
  stopAgent(id);
  if (!agentRow(id)) return;
  update(id, { status: "ended" });
  emit("session.ended", { id });
}

function apply(row: AgentRow, ev: AgentEvent, turnState: { ok?: boolean; last?: string; error?: string }) {
  switch (ev.kind) {
    case "session":
      if (!row.native_id) update(row.id, { native_id: ev.id, ...(ev.model && !row.model ? { model: ev.model } : {}) });
      row.native_id = ev.id;
      break;
    case "message":
      turnState.last = ev.text;
      write(row, { kind: "assistant", text: ev.text, model: row.model ?? undefined });
      break;
    case "thinking":
      write(row, { kind: "thinking", text: ev.text });
      break;
    case "tool":
      write(row, { kind: "tool", toolUseId: ev.id, name: ev.name, input: ev.input });
      break;
    case "tool_result":
      write(row, { kind: "tool_result", toolUseId: ev.id, text: ev.text.length > 20_000 ? `${ev.text.slice(0, 20_000)}…` : ev.text, isError: ev.isError });
      break;
    case "usage": {
      const r = agentRow(row.id)!;
      update(row.id, { tokens_in: r.tokens_in + ev.input, tokens_out: r.tokens_out + ev.output, ...(ev.costUSD !== undefined ? { cost: (r.cost ?? 0) + ev.costUSD } : {}) });
      break;
    }
    case "done":
      turnState.ok = ev.ok;
      if (ev.text && !turnState.last) turnState.last = ev.text;
      break;
    case "error":
      // Codex says the same failure twice, as an error and as the failed turn
      if (turnState.error === ev.text) break;
      turnState.error = ev.text;
      write(row, { kind: "system", subtype: "error", text: ev.text });
      break;
  }
}

function turn(id: string, prompt: string): void {
  const row = agentRow(id);
  const p = row && agentProvider(row.agent);
  if (!row || !p) return;
  write(row, { kind: "user", text: prompt });
  update(id, { status: "busy", error: null });
  const state: Record<string, unknown> = {};
  const result: { ok?: boolean; last?: string; error?: string } = {};
  const writable = row.access === "readonly" ? [] : gitDirs(row.cwd);
  const argv = [agentBin(p), ...p.headless({ prompt, cwd: row.cwd, model: row.model ?? undefined, access: row.access, resume: row.native_id ?? undefined, writable })];
  let h: ReturnType<typeof spawnLines>;
  try {
    h = spawnLines(argv, {
      cwd: row.cwd,
      input: prompt,
      onLine: (line) => {
        let events: AgentEvent[] = [];
        try {
          events = p.parse(line, state);
        } catch {
          // a line that isn't its JSON (a warning, say) is left out
        }
        for (const ev of events) apply(row, ev, result);
        if (events.length) update(id, {});
      },
    });
  } catch (e) {
    return finished(id, { ...result, error: (e as Error).message });
  }
  running.set(id, h);
  h.done.then(({ code, stderr }) => {
    running.delete(id);
    if (result.ok === undefined && code !== 0) {
      const why = stderr.trim().split("\n").filter(Boolean).slice(-3).join("\n") || `${p.name} stopped (exit ${code})`;
      if (!result.error) write(row, { kind: "system", subtype: "error", text: why });
      result.error ??= why;
    }
    finished(id, result);
  });
}

function finished(id: string, r: { ok?: boolean; last?: string; error?: string }): void {
  const row = agentRow(id);
  if (!row) return;
  const next = waiting.get(id)?.shift();
  if (next !== undefined) return turn(id, next);
  waiting.delete(id);
  if (row.status === "ended") return;
  update(id, { status: "idle", error: r.ok ? null : r.error ?? null });
  const name = agentProvider(row.agent)?.name ?? row.agent;
  emit("session.idle", getSession(id));
  notify({ title: r.ok === false || r.error ? `${name} stopped with an error` : `${name} finished`, body: r.error ?? r.last?.slice(0, 200) ?? row.title ?? row.cwd, link: `/sessions/${id}`, kind: "session" });
}

// turns cut off by a restart: their sessions are left idle, ready for the next prompt
export function startAgentRunner() {
  db.prepare("update agent_sessions set status = 'idle', error = 'cockpit restarted during this turn' where status = 'busy'").run();
}
