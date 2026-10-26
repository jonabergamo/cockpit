// Codex's usage, from the files it writes for every conversation (~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl),
// so it counts every Codex session on the machine, not only the ones cockpit ran. After each turn Codex writes a
// token_count event with the conversation's running totals and the plan's limits (a 5 hour and a weekly window,
// whichever the plan has). There are no dollars in them: Codex is billed by plan or by key, and says neither.
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFrom } from "./claude/transcript.ts";
import { db } from "./db.ts";

db.exec(`
  create table if not exists codex_usage (
    id text primary key,
    session_id text,
    ts text not null,
    model text,
    cwd text,
    input integer not null default 0,
    output integer not null default 0,
    cache_read integer not null default 0,
    thinking integer not null default 0
  );
  create index if not exists codex_usage_ts on codex_usage (ts);
  create table if not exists codex_files (
    path text primary key,
    offset integer not null,
    size integer not null,
    session_id text,
    model text,
    cwd text,
    -- the running totals at the last token_count read, JSON
    last text
  );
  create table if not exists codex_limits (
    at integer primary key,
    plan text,
    windows text not null
  );
`);

export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

// One plan window as Codex says it: how long it is, how much of it is used and when it starts again
export interface CodexWindow {
  minutes: number;
  pct: number;
  resetsAt?: number;
}

interface Totals {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface CodexLine {
  session?: { id: string; cwd?: string };
  model?: string;
  usage?: { ts: string; total: Totals };
  limits?: { at: number; plan?: string; windows: CodexWindow[] };
}

// Only the lines that matter are parsed; the rest (tool output, messages) can be large
export function codexLine(line: string): CodexLine | undefined {
  if (line.includes('"type":"session_meta"')) {
    const p = JSON.parse(line).payload ?? {};
    return p.id ? { session: { id: p.id, cwd: p.cwd } } : undefined;
  }
  if (line.includes('"type":"turn_context"')) {
    const model = JSON.parse(line).payload?.model;
    return typeof model === "string" ? { model } : undefined;
  }
  if (!line.includes('"type":"token_count"')) return;
  const d = JSON.parse(line);
  const p = d.payload ?? {};
  const out: CodexLine = {};
  const ts = typeof d.timestamp === "string" ? d.timestamp : new Date().toISOString();
  if (p.info?.total_token_usage) out.usage = { ts, total: p.info.total_token_usage };
  const r = p.rate_limits;
  if (r) {
    const windows = [r.primary, r.secondary]
      .filter((w) => w && typeof w.used_percent === "number")
      .map((w) => ({ minutes: w.window_minutes ?? 0, pct: w.used_percent, resetsAt: w.resets_at ? w.resets_at * 1000 : undefined }));
    if (windows.length) out.limits = { at: Date.parse(ts), plan: r.plan_type ?? undefined, windows };
  }
  return out;
}

const getFile = db.prepare<[string], { offset: number; size: number; session_id: string | null; model: string | null; cwd: string | null; last: string | null }>("select * from codex_files where path = ?");
const putFile = db.prepare("insert or replace into codex_files (path, offset, size, session_id, model, cwd, last) values (?, ?, ?, ?, ?, ?, ?)");
// keyed by the conversation and its running total, so a file Codex moves or rewrites isn't counted twice
const putUsage = db.prepare("insert or ignore into codex_usage (id, session_id, ts, model, cwd, input, output, cache_read, thinking) values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
const lastLimits = db.prepare<[], { at: number; plan: string | null; windows: string }>("select * from codex_limits order by at desc limit 1");
const putLimits = db.prepare("insert or ignore into codex_limits (at, plan, windows) values (?, ?, ?)");

async function indexFile(path: string) {
  const { size } = await stat(path);
  const prev = getFile.get(path);
  if (prev?.size === size) return;
  const restart = !prev || prev.offset > size;
  let offset = restart ? 0 : prev.offset;
  let session = restart ? null : prev.session_id;
  let model = restart ? null : prev.model;
  let cwd = restart ? null : prev.cwd;
  // the running totals at the last event read: each new event's tokens are what it adds to them
  let last: Totals = restart ? {} : JSON.parse(prev.last ?? "{}");
  while (offset < size) {
    const chunk = await readFrom(path, offset);
    if (chunk.offset === offset) break;
    const rows: unknown[][] = [];
    let limits: CodexLine["limits"];
    for (const line of chunk.lines) {
      let l: CodexLine | undefined;
      try {
        l = codexLine(line);
      } catch {
        continue;
      }
      if (!l) continue;
      if (l.session) {
        session = l.session.id;
        cwd = l.session.cwd ?? cwd;
      }
      if (l.model) model = l.model;
      if (l.limits) limits = l.limits;
      const t = l.usage?.total;
      // the same totals again (a limits-only update) add nothing
      if (!t || !session || (t.total_tokens ?? 0) <= (last.total_tokens ?? 0)) continue;
      const d = (k: keyof Totals) => Math.max(0, (t[k] ?? 0) - (last[k] ?? 0));
      const cached = d("cached_input_tokens");
      // Codex counts cached input inside input; cockpit keeps them apart, as Claude Code does
      rows.push([`${session}:${t.total_tokens}`, session, l.usage!.ts, model, cwd, Math.max(0, d("input_tokens") - cached), d("output_tokens"), cached, d("reasoning_output_tokens")]);
      last = t;
    }
    db.transaction(() => rows.forEach((r) => putUsage.run(...r)))();
    if (limits) saveLimits(limits);
    offset = chunk.offset;
  }
  putFile.run(path, offset, size, session, model, cwd, JSON.stringify(last));
}

function saveLimits(l: NonNullable<CodexLine["limits"]>) {
  const prev = lastLimits.get();
  if (prev && prev.at >= l.at) return;
  const windows = JSON.stringify(l.windows);
  if (prev && prev.windows === windows) return;
  putLimits.run(l.at, l.plan ?? null, windows);
}

async function* rollouts(dir: string): AsyncGenerator<string> {
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, d.name);
    if (d.isDirectory()) yield* rollouts(p);
    else if (d.name.startsWith("rollout-") && d.name.endsWith(".jsonl")) yield p;
  }
}

let running: Promise<void> | null = null;
export const codexIndexing = () => !!running;

export function indexCodexUsage() {
  running ??= (async () => {
    for (const dir of ["sessions", "archived_sessions"]) {
      for await (const p of rollouts(join(codexHome(), dir))) await indexFile(p).catch(() => {});
    }
  })().finally(() => (running = null));
  return running;
}

// whether Codex has ever run here, so the Usage page knows to offer it
export const hasCodex = () => existsSync(join(codexHome(), "sessions")) || !!db.prepare("select 1 from codex_usage limit 1").get();

// The plan windows Codex last reported, as cockpit's 5 hour and weekly ones
export function codexLimits(sinceMs: number) {
  const toFiveSeven = (windows: CodexWindow[]) => {
    const pick = (lo: number, hi: number) => windows.find((w) => w.minutes >= lo && w.minutes <= hi);
    const as = (w?: CodexWindow) => (w ? { pct: w.pct, resetsAt: w.resetsAt } : {});
    return { five: as(pick(1, 24 * 60)), seven: as(pick(24 * 60 + 1, Infinity)) };
  };
  const rows = db.prepare<[number], { at: number; plan: string | null; windows: string }>("select * from codex_limits where at >= ? order by at").all(sinceMs);
  const latest = rows.at(-1) ?? lastLimits.get();
  // a window that has started again since the reading is back at zero
  const fresh = (w: CodexWindow) => (w.resetsAt && w.resetsAt < Date.now() ? { ...w, pct: 0 } : w);
  return {
    plan: latest?.plan ?? undefined,
    latest: latest && { at: latest.at, ...toFiveSeven((JSON.parse(latest.windows) as CodexWindow[]).map(fresh)) },
    series: rows.map((r) => {
      const w = toFiveSeven(JSON.parse(r.windows));
      return { at: r.at, five: w.five.pct ?? null, seven: w.seven.pct ?? null };
    }),
  };
}

export function codexRows(sinceIso: string) {
  return db
    .prepare<[string], { session_id: string | null; ts: string; model: string | null; cwd: string | null; input: number; output: number; cache_read: number; thinking: number }>(
      "select session_id, ts, model, cwd, input, output, cache_read, thinking from codex_usage where ts >= ?",
    )
    .all(sinceIso);
}

export function startCodexUsage() {
  setTimeout(() => indexCodexUsage().catch(() => {}), 15_000);
  setInterval(() => indexCodexUsage().catch(() => {}), 60_000);
}

// the names Codex gives its conversations (its resume list shows them), by id
export async function codexTitles() {
  const out = new Map<string, string>();
  const text = await readFile(join(codexHome(), "session_index.jsonl"), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    try {
      const d = JSON.parse(line);
      if (d.id && d.thread_name) out.set(d.id, d.thread_name);
    } catch {}
  }
  return out;
}
