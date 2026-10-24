import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.ts";

mkdirSync(paths.data, { recursive: true });

export const db = new Database(join(paths.data, "cockpit.db"));
// plugin tokens live in here, so only this user can read it
try {
  chmodSync(join(paths.data, "cockpit.db"), 0o600);
} catch {}
db.pragma("journal_mode = WAL");

db.exec(`
  create table if not exists sessions (
    id text primary key,
    project text not null,
    file text not null,
    cwd text,
    branch text,
    title text,
    last_prompt text,
    cost real,
    lines_added integer,
    lines_removed integer,
    first_ts text,
    last_ts text,
    offset integer not null default 0,
    size integer not null default 0
  );

  create table if not exists session_days (
    session_id text not null,
    date text not null,
    cost real not null,
    primary key (session_id, date)
  );

  create table if not exists links (
    ticket text not null,
    worktree text not null,
    primary key (ticket, worktree)
  );

  create table if not exists snapshots (
    taken_at text not null,
    sprint_id integer,
    key text not null,
    status text not null,
    points real,
    in_sprint integer not null default 1,
    primary key (taken_at, key)
  );

  create table if not exists transitions (
    key text not null,
    from_status text,
    to_status text not null,
    at text not null,
    source text not null,
    primary key (key, to_status, at)
  );

  create table if not exists sprints (
    id integer primary key,
    name text not null,
    start text,
    end text,
    goal text,
    state text
  );

  create table if not exists folders (
    path text primary key,
    added_at integer not null
  );

  create table if not exists cache (
    key text primary key,
    value text not null,
    updated_at integer not null
  );

  -- work cockpit starts for you: one row per attempt, grouped when you ask for several
  create table if not exists tasks (
    id text primary key,
    group_id text not null,
    title text not null,
    prompt text not null,
    ticket text,
    model text,
    attempt integer not null default 1,
    status text not null,
    depends_on text not null default '[]',
    worktree text,
    branch text,
    job_id text,
    term_id text,
    session_id text,
    created_at integer not null,
    started_at integer,
    finished_at integer,
    error text
  );

  create table if not exists autopilot (
    worktree text primary key,
    enabled integer not null,
    attempts integer not null default 0,
    signature text,
    last_at integer,
    gave_up integer not null default 0,
    note text
  );

  create table if not exists verify (
    worktree text primary key,
    state text not null,
    at integer not null,
    code integer,
    job_id text,
    fingerprint text,
    summary text
  );

  -- what happened, for "while you were away"
  create table if not exists events_log (
    id integer primary key autoincrement,
    at integer not null,
    kind text not null,
    title text not null,
    body text,
    link text,
    ref text
  );

  -- every test, lint, e2e, proof, verify and CI run; output lives in data/runs/<id>.log, files in data/runs/<id>/
  create table if not exists runs (
    id text primary key,
    kind text not null,
    name text not null,
    source text not null,
    ticket text,
    worktree text,
    cwd text,
    command text,
    status text not null,
    exit_code integer,
    started_at integer not null,
    ended_at integer,
    updated_at integer not null,
    summary text not null default '{}',
    artifacts text not null default '[]',
    meta text not null default '{}'
  );
  create index if not exists runs_started on runs (started_at);
  create index if not exists runs_ticket on runs (ticket);
`);

// sessions of agents cockpit runs a turn at a time (Codex, Gemini, Claude without a terminal); what they said is
// in file, one entry per line
db.exec(`
  create table if not exists agent_sessions (
    id text primary key,
    agent text not null,
    model text,
    cwd text not null,
    access text not null default 'sandbox',
    native_id text,
    title text,
    status text not null,
    file text not null,
    tokens_in integer not null default 0,
    tokens_out integer not null default 0,
    cost real,
    error text,
    started_at integer not null,
    updated_at integer not null
  );
`);

// flows being run: the recipe as it was when it started, and each step's rounds as JSON
db.exec(`
  create table if not exists flow_runs (
    id text primary key,
    flow text not null,
    title text not null,
    prompt text not null,
    ticket text,
    worktree text,
    branch text,
    status text not null,
    steps text not null,
    created_at integer not null,
    finished_at integer,
    error text
  );
`);

// columns added after their table first shipped
const hasColumn = (table: string, column: string) => (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
if (!hasColumn("tasks", "template")) db.exec("alter table tasks add column template text");
if (!hasColumn("tasks", "on_pr")) db.exec("alter table tasks add column on_pr text");
if (!hasColumn("tasks", "base")) db.exec("alter table tasks add column base text");
if (!hasColumn("agent_sessions", "parent")) db.exec("alter table agent_sessions add column parent text");
if (!hasColumn("flow_runs", "on_pr")) db.exec("alter table flow_runs add column on_pr text");
if (!hasColumn("flow_runs", "base")) db.exec("alter table flow_runs add column base text");
if (!hasColumn("flow_runs", "note")) db.exec("alter table flow_runs add column note text");
if (!hasColumn("tasks", "agent")) db.exec("alter table tasks add column agent text");
if (!hasColumn("tasks", "overnight")) db.exec("alter table tasks add column overnight integer not null default 0");

const inflight = new Map<string, Promise<unknown>>();

// Fresh rows come from sqlite; on a miss everyone asking for the same key at once shares one fetch.
// force refetches and overwrites the row, so other keys sharing a prefix keep their values.
export function cached<T>(key: string, maxAgeMs: number, fn: () => Promise<T>, force = false): Promise<T> {
  if (!force) {
    const row = db.prepare("select value, updated_at from cache where key = ?").get(key) as { value: string; updated_at: number } | undefined;
    if (row && Date.now() - row.updated_at < maxAgeMs) return Promise.resolve(JSON.parse(row.value));
  }
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn()
    .then((v) => {
      // nothing to keep (no active sprint, say) isn't kept, and asks again next time
      if (v !== undefined) db.prepare("insert or replace into cache (key, value, updated_at) values (?, ?, ?)").run(key, JSON.stringify(v), Date.now());
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const bust = (prefix: string) => db.prepare("delete from cache where key like ?").run(prefix + "%");
