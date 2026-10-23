// The overnight queue: tasks marked for it wait until you're away, then run one after another within the task
// queue's slots. The night has a spending cap; past it, or once your hours are over, the night ends and what's
// still running stops. A stuck task stops too, since nobody's there to unstick it. In the morning Today shows
// what's ready, what failed and what the night cost.
import type { Task } from "@cockpit/shared";
import { boardChanged } from "./board.ts";
import { amount, sessionsSpend, unitOf } from "./budget.ts";
import { listSessions } from "./claude/sessions.ts";
import { notify } from "./notify.ts";
import { getSettings, readRow, writeRow } from "./settings.ts";
import { stuckReason } from "./stuck.ts";
import { cancelTask, listTasks, updateTask } from "./tasks.ts";

export interface Night {
  on: boolean;
  // when this night started, or the last one did; its tasks are the overnight ones started since
  since?: number;
  endedAt?: number;
  // the button, or your hours
  by?: "you" | "hours";
  // why the last night ended
  why?: string;
}

const KEY = "overnight";
export const night = (): Night => readRow<Night>(KEY) ?? { on: false };
export const nightOn = () => night().on;

export function capOf(unit = unitOf()) {
  const o = getSettings().overnight;
  const n = unit === "usd" ? o.capUSD : o.capMTokens * 1e6;
  return n > 0 ? n : undefined;
}

// whether this hour is inside the night's hours, which may run past midnight (23 to 8)
export function inHours(hour: number, from: number, to: number) {
  if (from < 0 || from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

const tonight = (n: Night, all: Task[]) => all.filter((t) => t.overnight && !!n.since && (t.startedAt ?? 0) >= n.since);

export function startNight(by: Night["by"] = "you") {
  if (nightOn()) return night();
  const n: Night = { on: true, since: Date.now(), by };
  writeRow(KEY, n);
  const waiting = listTasks().filter((t) => t.overnight && t.status === "queued").length;
  notify({ title: "Overnight queue started", body: waiting ? `${waiting} ${waiting === 1 ? "task" : "tasks"} waiting, ${capOf() ? `up to ${amount(capOf()!, unitOf())}` : "with no cap"}` : "Nothing is waiting for it yet", link: "/tasks", kind: "task" });
  boardChanged();
  return n;
}

// running ones stop when the night ends for a reason other than you coming back
export function endNight(why: string, stopRunning: boolean) {
  const n = night();
  if (!n.on) return n;
  const all = listTasks();
  const mine = tonight(n, all);
  if (stopRunning)
    for (const t of mine.filter((x) => x.status === "running" || x.status === "starting")) {
      cancelTask(t.id);
      updateTask(t.id, { error: `Stopped: ${why}` });
    }
  const next: Night = { ...n, on: false, endedAt: Date.now(), why };
  writeRow(KEY, next);
  const s = summary(next, listTasks());
  notify({ title: "Overnight queue ended", body: `${why}. ${s.done} done, ${s.failed} failed${s.left ? `, ${s.left} still queued` : ""}, ${amount(s.spent, s.unit)} used.`, link: "/", kind: "task" });
  boardChanged();
  return next;
}

export function summary(n = night(), all = listTasks()) {
  const mine = tonight(n, all);
  const unit = unitOf();
  return {
    ...n,
    unit,
    cap: capOf(unit),
    spent: sessionsSpend(mine.flatMap((t) => (t.sessionId ? [t.sessionId] : [])), unit),
    done: mine.filter((t) => t.status === "done").length,
    failed: mine.filter((t) => t.status === "failed" || t.status === "cancelled").length,
    left: all.filter((t) => t.overnight && t.status === "queued").length,
    tasks: mine.map((t) => ({ id: t.id, group: t.group, title: t.title, status: t.status, error: t.error, worktree: t.worktree, sessionId: t.sessionId, spent: t.sessionId ? sessionsSpend([t.sessionId], unit) : 0 })),
  };
}

function tick() {
  const o = getSettings().overnight;
  const n = night();
  const hour = new Date().getHours();
  const hours = inHours(hour, o.fromHour, o.toHour);
  if (!n.on) {
    // only at the start of the hours, so ending a night by hand isn't undone a minute later
    if (hours && hour === o.fromHour && (n.endedAt ?? 0) < Date.now() - 3600_000) startNight("hours");
    return;
  }
  if (n.by === "hours" && !hours) return void endNight("Your night hours are over", true);
  const s = summary(n);
  if (s.cap && s.spent >= s.cap) return void endNight(`It used its cap of ${amount(s.cap, s.unit)}`, true);
  // nobody's there to unstick a task, so it makes room for the next one
  const live = listSessions({ liveOnly: true });
  for (const t of tonight(n, listTasks()).filter((x) => x.status === "running" && x.sessionId)) {
    const session = live.find((x) => x.id === t.sessionId);
    const why = session && stuckReason(session);
    if (why) {
      cancelTask(t.id);
      updateTask(t.id, { error: `Stopped overnight: ${why}` });
    }
  }
}

export function startOvernight() {
  setInterval(() => {
    try {
      tick();
    } catch (e) {
      console.error("overnight", e);
    }
  }, 60_000);
}
