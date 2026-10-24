// The Board: every piece of work in flight as one card (a worktree, a session outside any worktree, or a queued
// task), placed in the column that says what it needs next.
import { existsSync } from "node:fs";
import type { BoardCard, BoardColumn, PullRequest, Session, Task, Worktree } from "@cockpit/shared";
import { listSessions } from "./claude/sessions.ts";
import { db } from "./db.ts";
import { broadcast } from "./hub.ts";
import { knownPrs, myPrs, myTickets } from "./providers.ts";
import { ticketSpend } from "./budget.ts";
import { readRow, writeRow } from "./settings.ts";
import { stackRows } from "./stacked.ts";
import { stuckReason } from "./stuck.ts";
import { listTasks } from "./tasks.ts";
import { listWorktrees } from "./worktrees.ts";
import { agentProvider } from "./workers/index.ts";

const agentName = (id?: string) => (id ? (agentProvider(id)?.name ?? id) : "An agent");
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
  session?: Pick<Session, "status" | "updatedAt" | "waitingFor" | "background">;
  pr?: Pick<PullRequest, "state" | "checks" | "reviewDecision" | "mergeable" | "isDraft" | "reviewers">;
  verify?: { state: string };
  autopilot?: { on: boolean; gaveUp: boolean; busy?: boolean };
  task?: { status: string; error?: string; overnight?: boolean };
  stuck?: string;
  // the teammate's PR the work is built on
  stacked?: { pr: number; state: string };
}

// "Ana", "Ana and Ben", "Ana, Ben and 2 more"
export function names(list: string[]) {
  const u = [...new Set(list)];
  if (u.length <= 2) return u.join(" and ");
  return `${u.slice(0, 2).join(", ")} and ${u.length - 2} more`;
}

// who a PR is waiting on, and who asked for changes, from every place that knows
export function reviewState(pr?: Pick<PullRequest, "reviewers">) {
  const r = pr?.reviewers ?? [];
  return {
    waiting: names(r.filter((x) => x.state === "REQUESTED" || x.state === "PENDING").map((x) => x.name)),
    changes: names(r.filter((x) => x.state === "CHANGES_REQUESTED").map((x) => x.name)),
  };
}

// Most urgent first: anything that can't move without you, then work in progress, then what's waiting on others.
export function columnOf(c: ColumnInput): { column: BoardColumn; reason: string } {
  const pr = c.pr;
  const open = pr?.state === "OPEN";
  if (c.stuck) return { column: "needs", reason: c.stuck };
  if (c.task?.status === "running" && !c.session) return c.task.error ? { column: "needs", reason: c.task.error } : { column: "working", reason: "Starting Claude" };
  if (c.task && (c.task.status === "queued" || c.task.status === "starting") && !c.session) return { column: "queued", reason: c.task.status === "starting" ? "Setting up its worktree" : c.task.overnight ? "In the overnight queue" : "Waiting for a free slot" };
  if (c.session?.status === "waiting") return { column: "needs", reason: c.session.waitingFor === "input needed" ? "Claude needs your input" : c.session.waitingFor ? `Claude is waiting: ${c.session.waitingFor}` : "Claude is waiting for you" };
  if (pr?.state === "MERGED") return { column: "ready", reason: "Merged" };
  if (c.session?.status === "busy") return { column: "working", reason: c.session.background ? (c.session.background > 1 ? `${c.session.background} shells running in the background` : "Running in the background") : "Claude is working" };
  if (c.verify?.state === "running") return { column: "working", reason: "Running the checks" };
  const autopilot = !!c.autopilot?.on && !c.autopilot.gaveUp;
  const who = reviewState(pr);
  if (open && pr.checks === "fail") return autopilot ? { column: "working", reason: "Autopilot is fixing the checks" } : { column: "needs", reason: "Checks are failing" };
  if (open && (pr.reviewDecision === "CHANGES_REQUESTED" || who.changes))
    return autopilot ? { column: "working", reason: who.changes ? `Autopilot is on ${who.changes}'s review` : "Autopilot is on the review" } : { column: "needs", reason: who.changes ? `${who.changes} asked for changes` : "Changes requested" };
  if (open && pr.mergeable === "CONFLICTING") return { column: "needs", reason: "Merge conflict" };
  if (c.verify?.state === "fail") return { column: "needs", reason: "Its checks failed here" };
  if (c.stacked?.state === "moved") return { column: "needs", reason: `#${c.stacked.pr}, which it's built on, has new commits` };
  if (c.stacked?.state === "merged") return { column: "needs", reason: `#${c.stacked.pr}, which it's built on, merged` };
  if (c.autopilot?.gaveUp) return { column: "needs", reason: "Autopilot gave up" };
  if (c.task?.status === "done" && !open) return { column: "needs", reason: "Done, ready for you to look at" };
  if (open && pr.reviewDecision === "APPROVED" && pr.checks !== "pending") return { column: "ready", reason: "Approved" };
  if (open) return { column: "review", reason: pr.isDraft ? "Draft PR" : pr.checks === "pending" ? (who.waiting ? `Checks running, then ${who.waiting}` : "Checks running") : who.waiting ? `Waiting on ${who.waiting}` : "Waiting for review" };
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

// offline uses only the PRs already fetched and no ticket titles, so it never waits on the code host or tracker
// The nodes' boards, on a hub: each node puts its own together from its worktrees, sessions and automations
let remoteBoards: (offline: boolean) => Promise<BoardCard[]> = async () => [];
export const useRemoteBoards = (fn: typeof remoteBoards) => void (remoteBoards = fn);

export async function board(opts: { offline?: boolean } = {}): Promise<BoardCard[]> {
  const [mine, theirs] = await Promise.all([localBoard(opts), remoteBoards(!!opts.offline).catch(() => [])]);
  return [...mine, ...theirs].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function localBoard(opts: { offline?: boolean } = {}): Promise<BoardCard[]> {
  const [worktrees, prs, tickets] = await Promise.all([
    listWorktrees(false),
    opts.offline ? (knownPrs() ?? []) : myPrs().catch(() => [] as PullRequest[]),
    opts.offline ? [] : myTickets().catch(() => []),
  ]);
  // a node's sessions are on its own board, which comes in below; agents working in the background for a flow
  // or a session show on the card of the folder they work in, not as cards of their own
  const all = listSessions({ limit: 800 }).filter((s) => !s.node);
  const sessions = all.filter((s) => !s.parent);
  const helpers = all.filter((s) => s.parent && s.status !== "ended" && Date.now() - s.updatedAt < 6 * 3600_000);
  const titleOf = new Map(tickets.map((t) => [t.key, t.summary]));
  const verify = verifyRows();
  const autopilot = autopilotRows();
  const stacks = stackRows();
  const tasks = listTasks().filter((t) => !["cancelled"].includes(t.status));
  const hidden = archived();
  const costs = ticketSpend();
  const spendOf = (ticket?: string): BoardCard["spend"] => {
    const t = ticket ? costs.get(ticket) : undefined;
    return t && { spent: t.spent, limit: t.limit, unit: t.unit, warnPct: t.warnPct };
  };
  const cards: BoardCard[] = [];
  const recent = Date.now() - QUIET_DAYS * 24 * 3600_000;

  const sessionOf = (s?: Session): BoardCard["session"] => s && { id: s.id, status: s.status, waitingFor: s.waitingFor, background: s.background, updatedAt: s.updatedAt, name: s.name, term: s.term, pid: s.pid, title: s.title };
  const prOf = (p?: PullRequest): BoardCard["pr"] =>
    p && { number: p.number, url: p.url, title: p.title, state: p.state, checks: p.checks, ignoredFailing: p.ignoredFailing, review: p.reviewDecision, mergeable: p.mergeable, mergeState: p.mergeState, isDraft: p.isDraft, reviewers: p.reviewers };
  const taskOf = (t?: Task): BoardCard["task"] => t && { id: t.id, group: t.group, status: t.status, attempt: t.attempt, title: t.title };

  for (const wt of worktrees) {
    if (wt.main || !existsSync(wt.path)) continue;
    const { pr, session } = matchWorker(wt, prs, sessions);
    const task = tasks.find((t) => t.worktree === wt.path);
    const v = verify.get(wt.path);
    const a = autopilot.get(wt.path);
    const live = session && session.status !== "ended" ? session : undefined;
    const stuck = live ? stuckReason(live) : undefined;
    const st = stacks.get(wt.path);
    const mine = helpers.filter((h) => inside(wt.path, h.cwd));
    let placed = columnOf({ session: live, pr, verify: v, autopilot: a && { on: !!a.enabled, gaveUp: !!a.gave_up }, task, stuck, stacked: st });
    const working = mine.filter((h) => h.status === "busy");
    // nothing else needs you and something works in the background: it's working
    if (working.length && !["needs", "working"].includes(placed.column)) placed = { column: "working", reason: working.length > 1 ? `${working.length} agents working in the background` : `${agentName(working[0].agent)} is working in the background` };
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
      helpers: mine.length ? mine.map((h) => ({ id: h.id, agent: h.agent ?? "agent", title: h.title, status: h.status, flow: h.parent?.startsWith("flow:") ? h.parent.slice(5) : undefined })) : undefined,
      stuck,
      stacked: st && { pr: st.pr, url: st.url, title: st.title ?? undefined, author: st.author ?? undefined, branch: st.branch, target: st.target ?? undefined, state: st.state, note: st.note ?? undefined },
      spend: spendOf(wt.ticket),
      updatedAt,
    });
  }

  // live sessions outside every worktree: the main checkout, other projects
  const inWorktree = (cwd: string) => worktrees.some((w) => !w.main && inside(w.path, cwd));
  for (const s of sessions) {
    if (s.status === "ended" || inWorktree(s.cwd)) continue;
    if (tasks.some((t) => t.sessionId === s.id && t.worktree)) continue;
    const stuck = stuckReason(s);
    const mine = helpers.filter((h) => h.parent === `session:${s.id}`);
    let placed = columnOf({ session: s, stuck });
    if (mine.some((h) => h.status === "busy") && placed.column === "quiet") placed = { column: "working", reason: "Agents are working in the background" };
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
      helpers: mine.length ? mine.map((h) => ({ id: h.id, agent: h.agent ?? "agent", title: h.title, status: h.status })) : undefined,
      stuck,
      spend: spendOf(s.ticket),
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
      reason: t.status === "failed" ? (t.error ?? "It failed") : t.status === "done" ? "Done" : t.status === "starting" ? "Setting up its worktree" : t.overnight ? "In the overnight queue" : t.dependsOn.length ? "Waiting on another task or a free slot" : "Waiting for a free slot",
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
