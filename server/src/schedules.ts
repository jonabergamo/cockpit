// Terminals on a schedule: at a time, on the days picked, an agent starts in a folder with a prompt ("run the e2e
// suite and say what failed", "sum up the open PRs"), and its card goes on the workspace the schedule is for. They
// run from the hub, on whichever machine the folder is on; a time missed while the hub was asleep runs once it's
// back, the same day.
import { randomUUID } from "node:crypto";
import type { Schedule } from "@cockpit/shared";
import * as canvas from "./canvas.ts";
import { db } from "./db.ts";
import { broadcast } from "./hub.ts";
import { spawnTerm } from "./pty.ts";
import { spawnRemote } from "./remote/terminals.ts";
import { agentLaunch } from "./workers/index.ts";

db.exec(`create table if not exists schedules (
  id text primary key,
  name text not null,
  cwd text not null,
  node text,
  prompt text not null,
  at text not null,
  days text not null,
  canvas text,
  on_ integer not null default 1,
  last_run integer,
  last_term text,
  last_error text,
  created_at integer not null
)`);

type Row = { id: string; name: string; cwd: string; node: string | null; prompt: string; at: string; days: string; canvas: string | null; on_: number; last_run: number | null; last_term: string | null; last_error: string | null; created_at: number };
const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  name: r.name,
  cwd: r.cwd,
  node: r.node ?? undefined,
  prompt: r.prompt,
  at: r.at,
  days: JSON.parse(r.days),
  canvas: r.canvas ?? undefined,
  on: !!r.on_,
  lastRun: r.last_run ?? undefined,
  lastTerm: r.last_term ?? undefined,
  lastError: r.last_error ?? undefined,
  next: nextRun({ at: r.at, days: JSON.parse(r.days), on: !!r.on_ }),
});

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export type ScheduleInput = Pick<Schedule, "name" | "cwd" | "prompt" | "at" | "days"> & { node?: string; canvas?: string; on?: boolean };

function check(s: Partial<ScheduleInput>) {
  if (!s.name?.trim()) throw new Error("Give it a name");
  if (!s.cwd?.trim()) throw new Error("Pick the folder it runs in");
  if (!s.prompt?.trim()) throw new Error("Say what the agent should do");
  if (!s.at || !TIME.test(s.at)) throw new Error("The time is HH:MM, like 08:30");
  if (!Array.isArray(s.days) || !s.days.length || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error("Pick at least one day");
}

// the day's time it's set for, as a date on the day of `d`
const timeOn = (d: Date, at: string) => {
  const [h, m] = at.split(":").map(Number);
  const t = new Date(d);
  t.setHours(h, m, 0, 0);
  return t;
};

// when it runs next, from now
export function nextRun(s: Pick<Schedule, "at" | "days" | "on">, now = new Date()) {
  if (!s.on) return undefined;
  for (let i = 0; i < 8; i++) {
    const day = new Date(now);
    day.setDate(now.getDate() + i);
    const t = timeOn(day, s.at);
    if (s.days.includes(t.getDay()) && t.getTime() > now.getTime()) return t.getTime();
  }
}

// whether it's due now: today is one of its days, its time has come, and it hasn't run since
export function due(s: Pick<Schedule, "at" | "days" | "on" | "lastRun">, now = new Date()) {
  if (!s.on || !s.days.includes(now.getDay())) return false;
  const t = timeOn(now, s.at).getTime();
  return now.getTime() >= t && (s.lastRun ?? 0) < t;
}

export const listSchedules = () => db.prepare<[], Row>("select * from schedules order by at, name").all().map(toSchedule);
const row = (id: string) => db.prepare<[string], Row>("select * from schedules where id = ?").get(id);

export function addSchedule(s: ScheduleInput) {
  check(s);
  const id = randomUUID();
  db.prepare("insert into schedules (id, name, cwd, node, prompt, at, days, canvas, on_, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    s.name.trim().slice(0, 80),
    s.cwd.trim(),
    s.node && s.node !== "local" ? s.node : null,
    s.prompt.trim().slice(0, 8000),
    s.at,
    JSON.stringify([...new Set(s.days)].sort()),
    s.canvas ?? null,
    s.on === false ? 0 : 1,
    Date.now(),
  );
  // made after today's time: it starts tomorrow, not now
  db.prepare("update schedules set last_run = ? where id = ?").run(Date.now(), id);
  return toSchedule(row(id)!);
}

export function updateSchedule(id: string, patch: Partial<ScheduleInput>) {
  const was = row(id);
  if (!was) return;
  const next = { ...toSchedule(was), ...patch };
  check(next);
  db.prepare("update schedules set name = ?, cwd = ?, node = ?, prompt = ?, at = ?, days = ?, canvas = ?, on_ = ? where id = ?").run(
    next.name.trim().slice(0, 80),
    next.cwd.trim(),
    next.node && next.node !== "local" ? next.node : null,
    next.prompt.trim().slice(0, 8000),
    next.at,
    JSON.stringify([...new Set(next.days)].sort()),
    next.canvas ?? null,
    next.on === false ? 0 : 1,
    id,
  );
  // a new time or new days that put it before now don't make it run at once
  if (patch.at || patch.days || patch.on) db.prepare("update schedules set last_run = ? where id = ?").run(Date.now(), id);
  return toSchedule(row(id)!);
}

export const removeSchedule = (id: string) => db.prepare("delete from schedules where id = ?").run(id).changes > 0;

// its agent, started now: in its folder on its machine, with its prompt, its card on its workspace
export async function runSchedule(id: string, spawn = { local: spawnTerm, remote: spawnRemote }) {
  const s = row(id);
  if (!s) throw new Error("No such schedule");
  db.prepare("update schedules set last_run = ?, last_error = null where id = ?").run(Date.now(), id);
  try {
    const go = agentLaunch(s.prompt);
    const opts = { cwd: s.cwd, command: go.command, args: go.args, title: `⏰ ${s.name}` };
    const t = s.node ? await spawn.remote(s.node, opts) : spawn.local(opts);
    db.prepare("update schedules set last_term = ? where id = ?").run(t.id, id);
    if (s.canvas) void onto(s.canvas, t.id);
    broadcast({ type: "schedules" });
    return t;
  } catch (e) {
    db.prepare("update schedules set last_error = ? where id = ?").run(e instanceof Error ? e.message : String(e), id);
    broadcast({ type: "schedules" });
    throw e;
  }
}

// the canvas puts a new terminal on its first workspace as it lists it; this one goes to the schedule's
async function onto(workspace: string, term: string) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      canvas.placeTerm(workspace, term);
      broadcast({ type: "canvas" });
      return;
    } catch {}
  }
}

async function tick() {
  for (const s of listSchedules()) if (due(s)) await runSchedule(s.id).catch((e) => console.error("schedule", s.name, e));
}

export function startSchedules() {
  setInterval(() => void tick(), 30_000);
  setTimeout(() => void tick(), 10_000);
}
