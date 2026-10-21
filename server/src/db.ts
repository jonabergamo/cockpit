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
`);

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
      db.prepare("insert or replace into cache (key, value, updated_at) values (?, ?, ?)").run(key, JSON.stringify(v), Date.now());
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const bust = (prefix: string) => db.prepare("delete from cache where key like ?").run(prefix + "%");
