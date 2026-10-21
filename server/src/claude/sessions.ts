import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Session, SessionStatus, Subagent } from "@cockpit/shared";
import { config } from "../config.ts";
import { db } from "../db.ts";
import { escalate, sessionsChanged } from "../notify.ts";
import { broadcast } from "../hub.ts";
import { day, ticketOf } from "../util.ts";
import { readFrom } from "./transcript.ts";

export const projectsDir = join(config.claude.dir, "projects");
const registryDir = join(config.claude.dir, "sessions");

interface Live {
  pid: number;
  status: SessionStatus;
  waitingFor?: string;
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
        status: r.status === "busy" ? "busy" : r.status === "waiting" ? "waiting" : "idle",
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
    const dirs = await readdir(projectsDir, { withFileTypes: true });
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
  const cwds = new Set([...live.values()].map((l) => l.cwd).filter(Boolean) as string[]);
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
    pid: l?.pid,
    startedAt: l?.startedAt ?? (r.first_ts ? Date.parse(r.first_ts) : 0),
    updatedAt: Math.max(l?.updatedAt ?? 0, r.last_ts ? Date.parse(r.last_ts) : 0),
    branch,
    // the worktree folder in the path beats the branch, which moves between tickets in an epic worktree
    ticket: ticketOf(cwd, branch, r.title ?? undefined),
    worktree: worktreeOf(cwd),
    costUSD: r.cost ?? undefined,
    linesAdded: r.lines_added ?? undefined,
    linesRemoved: r.lines_removed ?? undefined,
    lastPrompt: r.last_prompt ?? undefined,
    size: r.size,
    term: l?.tmux?.match(/^cockpit-([^:]+):/)?.[1],
  };
}

export function listSessions(opts: { limit?: number; q?: string; ticket?: string; worktree?: string; liveOnly?: boolean } = {}) {
  const rows = db.prepare<[], Row>("select * from sessions order by last_ts desc").all();
  let out = rows.map(toSession);
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
  return r ? toSession(r) : undefined;
}

export const sessionFile = (id: string) => getRow.get(id)?.file;

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
  await refreshBranches();
  const sessions = listSessions({ liveOnly: true });
  const snap = JSON.stringify(sessions.map((s) => [s.id, s.status, s.waitingFor, s.title, s.costUSD, s.updatedAt, s.branch]));
  if (snap !== lastSnapshot) {
    lastSnapshot = snap;
    broadcast({ type: "sessions", sessions });
    sessionsChanged(sessions);
  }
  escalate(sessions);
}

export function startSessions() {
  indexAll().then(() => console.log(`indexed ${db.prepare("select count(*) n from sessions").get()?.["n" as never]} sessions`));
  setInterval(() => poll().catch((e) => console.error("session poll", e)), 1500);
  setInterval(() => indexAll().catch(() => {}), 5 * 60_000);
}
