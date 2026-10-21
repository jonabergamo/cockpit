// The Board: every piece of work in flight as one card (a worktree, a session outside any worktree, or a queued
// task), placed in the column that says what it needs next.
import { existsSync } from "node:fs";
import type { BoardCard, BoardColumn, PullRequest, Session, Task, Worktree } from "@cockpit/shared";
import { listSessions } from "./claude/sessions.ts";
import { db } from "./db.ts";
import { broadcast } from "./hub.ts";
import { myPrs, myTickets } from "./providers.ts";
import { readRow, writeRow } from "./settings.ts";
import { stuckReason } from "./stuck.ts";
import { listTasks } from "./tasks.ts";
import { listWorktrees } from "./worktrees.ts";

const inside = (root: string, cwd?: string) => !!cwd && (cwd === root || cwd.startsWith(root + "/"));
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

// The PR, sessions and ticket that belong to a worktree: its branch or ticket for the PR, its folder for sessions.
export function matchWorker(wt: Pick<Worktree, "path" | "branch" | "ticket">, prs: PullRequest[], sessions: Session[]) {
  const mine = prs.filter((p) => p.branch === wt.branch || (!!wt.ticket && p.ticket === wt.ticket));
  const pr = mine.find((p) => p.state === "OPEN") ?? mine.sort((a, b) => (b.mergedAt ?? b.createdAt).localeCompare(a.mergedAt ?? a.createdAt))[0];
  const ss = sessions.filter((s) => inside(wt.path, s.cwd)).sort((a, b) => Number(b.status !== "ended") - Number(a.status !== "ended") || b.updatedAt - a.updatedAt);
  return { pr, session: ss[0] };
}

export interface ColumnInput {
  session?: Pick<Session, "status" | "updatedAt" | "waitingFor">;
  pr?: Pick<PullRequest, "state" | "checks" | "reviewDecision" | "mergeable" | "isDraft">;
  verify?: { state: string };
  autopilot?: { on: boolean; gaveUp: boolean; busy?: boolean };
  task?: { status: string; error?: string };
  stuck?: string;
}

// Most urgent first: anything that can't move without you, then work in progress, then what's waiting on others.
export function columnOf(c: ColumnInput): { column: BoardColumn; reason: string } {
  const pr = c.pr;
  const open = pr?.state === "OPEN";
  if (c.stuck) return { column: "needs", reason: c.stuck };
  if (c.task?.status === "running" && !c.session) return c.task.error ? { column: "needs", reason: c.task.error } : { column: "working", reason: "Starting Claude" };
  if (c.task && (c.task.status === "queued" || c.task.status === "starting") && !c.session) return { column: "queued", reason: c.task.status === "starting" ? "Setting up its worktree" : "Waiting for a free slot" };
  if (c.session?.status === "waiting") return { column: "needs", reason: c.session.waitingFor === "input needed" ? "Claude needs your input" : c.session.waitingFor ? `Claude is waiting: ${c.session.waitingFor}` : "Claude is waiting for you" };
  if (pr?.state === "MERGED") return { column: "ready", reason: "Merged" };
  if (c.session?.status === "busy") return { column: "working", reason: "Claude is working" };
  if (c.verify?.state === "running") return { column: "working", reason: "Running the checks" };
  const autopilot = !!c.autopilot?.on && !c.autopilot.gaveUp;
  if (open && pr.checks === "fail") return autopilot ? { column: "working", reason: "Autopilot is fixing the checks" } : { column: "needs", reason: "Checks are failing" };
  if (open && pr.reviewDecision === "CHANGES_REQUESTED") return autopilot ? { column: "working", reason: "Autopilot is on the review" } : { column: "needs", reason: "Changes requested" };
  if (open && pr.mergeable === "CONFLICTING") return { column: "needs", reason: "Merge conflict" };
  if (c.verify?.state === "fail") return { column: "needs", reason: "Its checks failed here" };
  if (c.autopilot?.gaveUp) return { column: "needs", reason: "Autopilot gave up" };
  if (c.task?.status === "done" && !open) return { column: "needs", reason: "Done, ready for you to look at" };
  if (open && pr.reviewDecision === "APPROVED" && pr.checks !== "pending") return { column: "ready", reason: "Approved" };
  if (open) return { column: "review", reason: pr.isDraft ? "Draft PR" : pr.checks === "pending" ? "Checks running" : "Waiting for review" };
  // a finished turn with nothing else going on isn't a call for you
  if (c.session?.status === "idle") return { column: "quiet", reason: "Claude finished its turn" };
  return { column: "quiet", reason: "Nothing running" };
}

const verifyRows = () =>
  new Map(db.prepare<[], { worktree: string; state: string; at: number; summary: string | null; job_id: string | null }>("select worktree, state, at, summary, job_id from verify").all().map((r) => [r.worktree, r]));
const autopilotRows = () =>
  new Map(db.prepare<[], { worktree: string; enabled: number; attempts: number; gave_up: number; note: string | null }>("select worktree, enabled, attempts, gave_up, note from autopilot").all().map((r) => [r.worktree, r]));

export const archived = () => new Set(readRow<string[]>("board-archived") ?? []);
export function archive(id: string, on: boolean) {
  const set = archived();
  if (on) set.add(id);
  else set.delete(id);
  writeRow("board-archived", [...set].slice(-500));
  boardChanged();
}

const QUIET_DAYS = 3;

export async function board(): Promise<BoardCard[]> {
  const [worktrees, prs, tickets] = await Promise.all([listWorktrees(false), myPrs().catch(() => [] as PullRequest[]), myTickets().catch(() => [])]);
  const sessions = listSessions({ limit: 800 });
  const titleOf = new Map(tickets.map((t) => [t.key, t.summary]));
  const verify = verifyRows();
  const autopilot = autopilotRows();
  const tasks = listTasks().filter((t) => !["cancelled"].includes(t.status));
  const hidden = archived();
  const cards: BoardCard[] = [];
  const recent = Date.now() - QUIET_DAYS * 24 * 3600_000;

  const sessionOf = (s?: Session): BoardCard["session"] => s && { id: s.id, status: s.status, waitingFor: s.waitingFor, updatedAt: s.updatedAt, name: s.name, term: s.term, pid: s.pid, title: s.title };
  const prOf = (p?: PullRequest): BoardCard["pr"] =>
    p && { number: p.number, url: p.url, title: p.title, state: p.state, checks: p.checks, review: p.reviewDecision, mergeable: p.mergeable, mergeState: p.mergeState, isDraft: p.isDraft };
  const taskOf = (t?: Task): BoardCard["task"] => t && { id: t.id, group: t.group, status: t.status, attempt: t.attempt, title: t.title };

  for (const wt of worktrees) {
    if (wt.main || !existsSync(wt.path)) continue;
    const { pr, session } = matchWorker(wt, prs, sessions);
    const task = tasks.find((t) => t.worktree === wt.path);
    const v = verify.get(wt.path);
    const a = autopilot.get(wt.path);
    const live = session && session.status !== "ended" ? session : undefined;
    const stuck = live ? stuckReason(live) : undefined;
    const placed = columnOf({ session: live, pr, verify: v, autopilot: a && { on: !!a.enabled, gaveUp: !!a.gave_up }, task, stuck });
    const updatedAt = Math.max(session?.updatedAt ?? 0, pr ? Date.parse(pr.mergedAt ?? pr.createdAt) : 0, v?.at ?? 0, task?.createdAt ?? 0);
    // old worktrees nobody touched lately stay off the board unless you ask for them
    if (placed.column === "quiet" && updatedAt < recent) continue;
    if (pr?.state === "MERGED" && hidden.has(wt.path)) continue;
    if (pr?.state === "CLOSED" && !live) continue;
    cards.push({
      id: wt.path,
      kind: "worktree",
      title: task?.title ?? (wt.ticket && titleOf.get(wt.ticket)) ?? pr?.title ?? session?.title ?? wt.name,
      ticket: wt.ticket,
      folder: `${wt.name} · ${base(wt.path)}`,
      path: wt.path,
      branch: wt.branch,
      ...placed,
      session: sessionOf(session),
      pr: prOf(pr),
      verify: v && { state: v.state as "running" | "pass" | "fail", at: v.at, summary: v.summary ?? undefined, jobId: v.job_id ?? undefined },
      autopilot: a && { on: !!a.enabled, attempts: a.attempts, gaveUp: !!a.gave_up, note: a.note ?? undefined },
      task: taskOf(task),
      stuck,
      updatedAt,
    });
  }

  // live sessions outside every worktree: the main checkout, other projects
  const inWorktree = (cwd: string) => worktrees.some((w) => !w.main && inside(w.path, cwd));
  for (const s of sessions) {
    if (s.status === "ended" || inWorktree(s.cwd)) continue;
    if (tasks.some((t) => t.sessionId === s.id && t.worktree)) continue;
    const stuck = stuckReason(s);
    const placed = columnOf({ session: s, stuck });
    cards.push({
      id: `s:${s.id}`,
      kind: "session",
      title: s.title ?? s.name ?? base(s.cwd),
      ticket: s.ticket,
      folder: base(s.cwd),
      path: s.cwd,
      branch: s.branch,
      ...placed,
      session: sessionOf(s),
      stuck,
      updatedAt: s.updatedAt,
    });
  }

  // tasks still waiting for their worktree
  for (const t of tasks) {
    if (t.worktree && cards.some((c) => c.path === t.worktree)) continue;
    if (t.status === "done" || t.status === "failed") {
      if (hidden.has(`t:${t.id}`) || (t.finishedAt ?? 0) < recent) continue;
    }
    const column: BoardColumn = t.status === "failed" ? "needs" : t.status === "done" ? "ready" : "queued";
    cards.push({
      id: `t:${t.id}`,
      kind: "task",
      title: t.title,
      ticket: t.ticket,
      folder: t.worktree ? base(t.worktree) : "new worktree",
      path: t.worktree,
      branch: t.branch,
      column,
      reason: t.status === "failed" ? (t.error ?? "It failed") : t.status === "done" ? "Done" : t.status === "starting" ? "Setting up its worktree" : t.dependsOn.length ? "Waiting on another task or a free slot" : "Waiting for a free slot",
      task: taskOf(t),
      updatedAt: t.createdAt,
    });
  }

  return cards.sort((a, b) => b.updatedAt - a.updatedAt);
}

let pending: NodeJS.Timeout | undefined;
// tells open boards to fetch again; a burst of changes becomes one message
export function boardChanged() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = undefined;
    broadcast({ type: "board" });
  }, 400);
}
