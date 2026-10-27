import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Session, SessionStatus, Subagent } from "@cockpit/shared";
import { config } from "../config.ts";
import { db } from "../db.ts";
import { escalate, sessionsChanged } from "../notify.ts";
import { broadcast } from "../hub.ts";
import { day, ticketOf, ticketOfPath } from "../util.ts";
import { agentRow, agentRows, type AgentRow } from "../workers/runner.ts";
import { codexTerminalFile, codexTerminalSessions, isCodexTerminal, scanCodexTerminals } from "./codexTerminal.ts";
import { agentProvider } from "../workers/index.ts";
import { backgroundShells } from "./background.ts";
import { readFrom } from "./transcript.ts";

export const projectsDir = join(config.claude.dir, "projects");
const registryDir = join(config.claude.dir, "sessions");

interface Live {
  pid: number;
  status: SessionStatus;
  waitingFor?: string;
  background?: number;
  name?: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  // "<tmux session>:@window.%pane" when it runs inside tmux
  tmux?: string;
}

let live = new Map<string, Live>();
export const liveInfo = (id: string) => live.get(id);

async function readRegistry() {
  const next = new Map<string, Live>();
  const files = await readdir(registryDir).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(await readFile(join(registryDir, f), "utf8"));
      if (!existsSync(`/proc/${r.pid}`)) continue;
      next.set(r.sessionId, {
        pid: r.pid,
        // Claude Code writes "waiting" with a waitingFor when a question or dialog needs you
        // "shell" is Claude Code's own word for a turn that ended with background shells still running
        status: r.status === "busy" || r.status === "shell" ? "busy" : r.status === "waiting" ? "waiting" : "idle",
        background: r.status === "shell" ? 1 : undefined,
        waitingFor: r.status === "waiting" && typeof r.waitingFor === "string" ? r.waitingFor : undefined,
        name: r.name,
        cwd: r.cwd,
        startedAt: r.startedAt,
        updatedAt: r.statusUpdatedAt ?? r.updatedAt,
        tmux: typeof r.tmux === "string" ? r.tmux : undefined,
      });
    } catch {
      // registry files get rewritten while we read them, next poll catches up
    }
  }
  // how many shells each one has left running, and the same check for Claude versions that don't say "shell"
  const ended = [...next.values()].filter((l) => l.status === "idle" || l.background);
  const shells = await backgroundShells(new Set(ended.map((l) => l.pid)));
  for (const l of ended) {
    const n = shells.get(l.pid);
    if (n) Object.assign(l, { status: "busy", background: n });
  }
  return next;
}

interface Row {
  id: string;
  project: string;
  file: string;
  cwd: string | null;
  branch: string | null;
  title: string | null;
  last_prompt: string | null;
  cost: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  first_ts: string | null;
  last_ts: string | null;
  offset: number;
  size: number;
}

const getRow = db.prepare<[string], Row>("select * from sessions where id = ?");
const upsert = db.prepare(`
  insert into sessions (id, project, file, cwd, branch, title, last_prompt, cost, lines_added, lines_removed, first_ts, last_ts, offset, size)
  values (@id, @project, @file, @cwd, @branch, @title, @last_prompt, @cost, @lines_added, @lines_removed, @first_ts, @last_ts, @offset, @size)
  on conflict(id) do update set
    cwd = excluded.cwd, branch = excluded.branch, title = excluded.title, last_prompt = excluded.last_prompt,
    cost = excluded.cost, lines_added = excluded.lines_added, lines_removed = excluded.lines_removed,
    first_ts = excluded.first_ts, last_ts = excluded.last_ts, offset = excluded.offset, size = excluded.size
`);
const upsertDay = db.prepare("insert into session_days (session_id, date, cost) values (?, ?, ?) on conflict do update set cost = max(cost, excluded.cost)");

function field(line: string, key: string, last = false) {
  const needle = `"${key}":"`;
  const i = last ? line.lastIndexOf(needle) : line.indexOf(needle);
  if (i === -1) return;
  const start = i + needle.length;
  return line.slice(start, line.indexOf('"', start));
}

// Cheap scan: only parses the few line types that carry metadata, everything else is regex'd.
function scanLine(line: string, row: Row, days: Map<string, number>) {
  if (line.startsWith('{"type":"ai-title"')) {
    row.title = JSON.parse(line).aiTitle;
  } else if (line.startsWith('{"type":"last-prompt"')) {
    row.last_prompt = JSON.parse(line).lastPrompt;
  } else if (line.startsWith('{"type":"cost-state"')) {
    const d = JSON.parse(line);
    row.cost = d.totalCostUSD;
    row.lines_added = d.totalLinesAdded;
    row.lines_removed = d.totalLinesRemoved;
    if (row.last_ts) days.set(day(row.last_ts), d.totalCostUSD);
  } else if (line.startsWith('{"type":"api-') || line.startsWith('{"type":"file-history')) {
    return;
  } else {
    const ts = field(line, "timestamp", true);
    if (ts && ts.length < 40) {
      row.first_ts ??= ts;
      row.last_ts = ts;
    }
    const br = field(line, "gitBranch");
    if (br && br !== "HEAD") row.branch = br;
    if (!row.cwd) row.cwd = field(line, "cwd") ?? null;
  }
}

export async function indexFile(file: string, project: string) {
  const id = basename(file, ".jsonl");
  const { size } = await stat(file);
  const prev = getRow.get(id);
  if (prev && prev.size === size) return false;

  const row: Row = prev && prev.offset <= size
    ? { ...prev, file }
    : { id, project, file, cwd: null, branch: null, title: null, last_prompt: null, cost: null, lines_added: null, lines_removed: null, first_ts: null, last_ts: null, offset: 0, size: 0 };

  const days = new Map<string, number>();
  while (row.offset < size) {
    const chunk = await readFrom(file, row.offset);
    if (chunk.offset === row.offset) break;
    for (const line of chunk.lines) {
      try {
        scanLine(line, row, days);
      } catch {
        // a malformed line shouldn't stop the index
      }
    }
    row.offset = chunk.offset;
  }
  row.size = size;

  db.transaction(() => {
    upsert.run(row);
    for (const [d, cost] of days) upsertDay.run(id, d, cost);
  })();
  return true;
}

let indexing: Promise<void> | null = null;

export function indexAll() {
  indexing ??= (async () => {
    // no ~/.claude yet: someone who doesn't use Claude Code, or hasn't run it
    const dirs = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const files = await readdir(join(projectsDir, d.name)).catch(() => [] as string[]);
      for (const f of files) {
        if (f.endsWith(".jsonl")) await indexFile(join(projectsDir, d.name, f), d.name).catch(() => {});
      }
    }
  })().finally(() => (indexing = null));
  return indexing;
}

function worktreeOf(cwd?: string | null) {
  if (!cwd || !cwd.startsWith(config.repo.worktreesDir + "/")) return;
  const rest = cwd.slice(config.repo.worktreesDir.length + 1).split("/");
  return join(config.repo.worktreesDir, ...rest.slice(0, 2));
}

// The transcript only notes the branch when Claude writes to it, so for running sessions read it from git itself:
// a checkout in another terminal shows up on the next poll.
const currentBranch = new Map<string, string>();

async function headOf(cwd: string) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    const info = await stat(dotGit).catch(() => undefined);
    if (info) {
      // a worktree's .git is a file pointing at its real git dir
      const gitDir = info.isDirectory() ? dotGit : resolve(dir, (await readFile(dotGit, "utf8")).replace(/^gitdir:\s*/, "").trim());
      const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
      return head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 7);
    }
    if (dirname(dir) === dir) return undefined;
  }
}

async function refreshBranches() {
  const cwds = new Set(
    [...[...live.values()].map((l) => l.cwd), ...agentRows().filter((a) => a.status !== "ended").map((a) => a.cwd), ...codexTerminalSessions().filter((s) => s.status !== "ended").map((s) => s.cwd)].filter(Boolean) as string[],
  );
  for (const cwd of cwds) {
    const branch = await headOf(cwd).catch(() => undefined);
    if (branch) currentBranch.set(cwd, branch);
    else currentBranch.delete(cwd);
  }
  for (const cwd of currentBranch.keys()) if (!cwds.has(cwd)) currentBranch.delete(cwd);
}

function toSession(r: Row): Session {
  const l = live.get(r.id);
  const cwd = r.cwd ?? l?.cwd ?? "";
  const branch = (l && currentBranch.get(l.cwd)) ?? r.branch ?? undefined;
  return {
    id: r.id,
    project: r.project,
    cwd,
    title: r.title ?? undefined,
    name: l?.name,
    status: l ? l.status : "ended",
    waitingFor: l?.waitingFor,
    background: l?.background,
    pid: l?.pid,
    startedAt: l?.startedAt ?? (r.first_ts ? Date.parse(r.first_ts) : 0),
    updatedAt: Math.max(l?.updatedAt ?? 0, r.last_ts ? Date.parse(r.last_ts) : 0),
    branch,
    // the worktree folder in the path beats the branch, which moves between tickets in an epic worktree
    ticket: ticketOfPath(cwd) || ticketOf(branch, r.title ?? undefined),
    worktree: worktreeOf(cwd),
    costUSD: r.cost ?? undefined,
    linesAdded: r.lines_added ?? undefined,
    linesRemoved: r.lines_removed ?? undefined,
    lastPrompt: r.last_prompt ?? undefined,
    size: r.size,
    term: l?.tmux?.match(/^cockpit-([^:]+):/)?.[1],
  };
}

// an agent cockpit runs a turn at a time, listed with the rest; one left idle for half a day counts as ended
const IDLE_ENDS_MS = 12 * 3600_000;
function agentSession(r: AgentRow): Session {
  // a conversation opened in the agent's own screen is busy while it works there, as its own files say
  const open = r.status !== "busy" && !!r.native_id && !!agentProvider(r.agent)?.busy?.(r.native_id);
  const status = open ? "busy" : r.status === "idle" && Date.now() - r.updated_at > IDLE_ENDS_MS ? "ended" : r.status;
  const branch = currentBranch.get(r.cwd);
  const title = r.title ?? undefined;
  return {
    id: r.id,
    project: r.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    cwd: r.cwd,
    title,
    status,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    branch,
    ticket: ticketOfPath(r.cwd) || ticketOf(branch, title),
    worktree: worktreeOf(r.cwd),
    costUSD: r.cost ?? undefined,
    size: existsSync(r.file) ? 1 : 0,
    agent: r.agent,
    model: r.model ?? undefined,
    tokens: { input: r.tokens_in, output: r.tokens_out },
  };
}

// this machine's Claude sessions and agent sessions; a Claude conversation cockpit ran as an agent is shown once
function mine() {
  const agents = agentRows();
  const native = new Set(agents.filter((a) => a.agent === "claude" && a.native_id).map((a) => a.native_id));
  const claude = db.prepare<[], Row>("select * from sessions order by last_ts desc").all().filter((r) => !native.has(r.id));
  const tui = codexTerminalSessions().map((s) => {
    const branch = currentBranch.get(s.cwd);
    return { ...s, branch, ticket: ticketOfPath(s.cwd) || ticketOf(branch, s.title), worktree: worktreeOf(s.cwd) };
  });
  return [...claude.map(toSession), ...agents.map(agentSession), ...tui];
}

// Sessions on other machines, which a hub lists next to its own; set once nodes can be reached
export interface RemoteSessions {
  list(): Session[];
  get(id: string): Session | undefined;
}
let remote: RemoteSessions | undefined;
export const useRemoteSessions = (r: RemoteSessions) => void (remote = r);

export type ListOpts = { limit?: number; q?: string; ticket?: string; worktree?: string; liveOnly?: boolean };

// this machine's own, what a node tells its hub
export function localSessions(opts: ListOpts = {}) {
  return filterSessions(mine(), opts);
}

export function listSessions(opts: ListOpts = {}) {
  if (!remote) return localSessions(opts);
  return filterSessions([...mine(), ...remote.list()], opts);
}

function filterSessions(all: Session[], opts: ListOpts) {
  let out = all;
  if (opts.liveOnly) out = out.filter((s) => s.status !== "ended");
  if (opts.ticket) out = out.filter((s) => s.ticket === opts.ticket);
  if (opts.worktree) out = out.filter((s) => s.worktree === opts.worktree || s.cwd.startsWith(opts.worktree + "/") || s.cwd === opts.worktree);
  if (opts.q) {
    const q = opts.q.toLowerCase();
    out = out.filter((s) => [s.title, s.lastPrompt, s.cwd, s.branch, s.ticket].some((v) => v?.toLowerCase().includes(q)));
  }
  // live sessions first, then by recency
  out.sort((a, b) => Number(b.status !== "ended") - Number(a.status !== "ended") || b.updatedAt - a.updatedAt);
  return out.slice(0, opts.limit ?? 200);
}

export function getSession(id: string) {
  const r = getRow.get(id);
  if (r) return toSession(r);
  const a = agentRow(id);
  if (a) return agentSession(a);
  if (isCodexTerminal(id)) return mine().find((s) => s.id === id);
  return remote?.get(id);
}

export const sessionFile = (id: string) => getRow.get(id)?.file ?? agentRow(id)?.file ?? codexTerminalFile(id);

export async function agentFile(sessionId: string, agentId: string) {
  const file = sessionFile(sessionId);
  if (!file) return;
  const base = join(dirname(file), sessionId, "subagents");
  const direct = join(base, `agent-${agentId}.jsonl`);
  if (existsSync(direct)) return direct;
  const wfs = await readdir(join(base, "workflows")).catch(() => [] as string[]);
  for (const wf of wfs) {
    const p = join(base, "workflows", wf, `agent-${agentId}.jsonl`);
    if (existsSync(p)) return p;
  }
}

export async function listSubagents(sessionId: string): Promise<Subagent[]> {
  const file = sessionFile(sessionId);
  if (!file) return [];
  const base = join(dirname(file), sessionId, "subagents");
  const out: Subagent[] = [];

  const collect = async (dir: string, workflowRun?: string) => {
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        const m = JSON.parse(await readFile(join(dir, f), "utf8"));
        out.push({
          id: f.slice("agent-".length, -".meta.json".length),
          type: m.agentType ?? "agent",
          description: m.description ?? "",
          toolUseId: m.toolUseId,
          model: m.model,
          finished: !!m.finished,
          workflowRun,
          phase: m.workflowPhase,
        });
      } catch {}
    }
  };

  await collect(base);
  const wfs = await readdir(join(base, "workflows")).catch(() => [] as string[]);
  for (const wf of wfs) await collect(join(base, "workflows", wf), wf);
  return out;
}

export function costByDay(from: string, to: string) {
  // session_days stores the cumulative cost at the end of each day, so per-day cost is the delta
  const rows = db
    .prepare<[], { session_id: string; date: string; cost: number }>("select session_id, date, cost from session_days order by session_id, date")
    .all();
  const out = new Map<string, { cost: number; sessions: Map<string, number> }>();
  let prevId = "";
  let prevCost = 0;
  for (const r of rows) {
    if (r.session_id !== prevId) {
      prevId = r.session_id;
      prevCost = 0;
    }
    const delta = Math.max(0, r.cost - prevCost);
    prevCost = r.cost;
    if (r.date < from || r.date > to) continue;
    const d = out.get(r.date) ?? { cost: 0, sessions: new Map() };
    d.cost += delta;
    d.sessions.set(r.session_id, (d.sessions.get(r.session_id) ?? 0) + delta);
    out.set(r.date, d);
  }
  return out;
}

let lastSnapshot = "";

async function poll() {
  live = await readRegistry();
  for (const id of live.keys()) {
    const file = sessionFile(id);
    if (file) await indexFile(file, basename(dirname(file))).catch(() => {});
    else await indexAll();
  }
  await scanCodexTerminals().catch((e) => console.error("codex sessions", e));
  await refreshBranches();
  const sessions = listSessions({ liveOnly: true });
  const snap = JSON.stringify(sessions.map((s) => [s.id, s.status, s.waitingFor, s.background, s.title, s.costUSD, s.updatedAt, s.branch]));
  if (snap !== lastSnapshot) {
    lastSnapshot = snap;
    broadcast({ type: "sessions", sessions });
    // a node's sessions are its to tell about, through its outbox, so they still arrive after this one slept;
    // agents run a turn at a time say when they start and finish themselves
    // Codex in a terminal says nothing itself either, so it goes with Claude Code's
    sessionsChanged(sessions.filter((s) => !s.node && (!s.agent || isCodexTerminal(s.id))));
  }
  escalate(sessions.filter((s) => !s.node && (!s.agent || isCodexTerminal(s.id))));
}

export function startSessions() {
  indexAll()
    .then(() => console.log(`indexed ${db.prepare("select count(*) n from sessions").get()?.["n" as never]} sessions`))
    .catch((e) => console.error("session index", e));
  setInterval(() => poll().catch((e) => console.error("session poll", e)), 1500);
  setInterval(() => indexAll().catch(() => {}), 5 * 60_000);
}
