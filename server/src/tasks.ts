// Tasks: work you hand to cockpit to run in a fresh worktree with its own Claude. Several attempts of one
// task form a group, so the results can be compared. A queue keeps how many run at once in check.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, Task, TaskStatus } from "@cockpit/shared";
import { acceptTrust, captureTarget, termTarget, trustDialog } from "./agents.ts";
import { boardChanged } from "./board.ts";
import { listSessions } from "./claude/sessions.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { emit, onEvent } from "./events.ts";
import { notify } from "./notify.ts";
import { statusesOf } from "./providers.ts";
import { kill, listTerms, spawnTerm } from "./pty.ts";
import { getSettings } from "./settings.ts";
import { run } from "./util.ts";
import { createWorktree, deleteWorktree } from "./worktrees.ts";

interface Row {
  id: string;
  group_id: string;
  title: string;
  prompt: string;
  ticket: string | null;
  model: string | null;
  attempt: number;
  status: TaskStatus;
  depends_on: string;
  worktree: string | null;
  branch: string | null;
  job_id: string | null;
  term_id: string | null;
  session_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}

const toTask = (r: Row): Task => ({
  id: r.id,
  group: r.group_id,
  title: r.title,
  prompt: r.prompt,
  ticket: r.ticket ?? undefined,
  model: r.model ?? undefined,
  attempt: r.attempt,
  status: r.status,
  dependsOn: JSON.parse(r.depends_on || "[]"),
  worktree: r.worktree ?? undefined,
  branch: r.branch ?? undefined,
  jobId: r.job_id ?? undefined,
  termId: r.term_id ?? undefined,
  sessionId: r.session_id ?? undefined,
  createdAt: r.created_at,
  startedAt: r.started_at ?? undefined,
  finishedAt: r.finished_at ?? undefined,
  error: r.error ?? undefined,
});

export const listTasks = (): Task[] => db.prepare<[], Row>("select * from tasks order by created_at desc limit 500").all().map(toTask);
export const getTask = (id: string) => {
  const r = db.prepare<[string], Row>("select * from tasks where id = ?").get(id);
  return r && toTask(r);
};
export const groupTasks = (group: string) => db.prepare<[string], Row>("select * from tasks where group_id = ? order by attempt").all(group).map(toTask);

const COLUMNS: Record<string, keyof Row> = {
  status: "status",
  worktree: "worktree",
  branch: "branch",
  jobId: "job_id",
  termId: "term_id",
  sessionId: "session_id",
  startedAt: "started_at",
  finishedAt: "finished_at",
  error: "error",
};

export function updateTask(id: string, patch: Partial<Pick<Task, "status" | "worktree" | "branch" | "jobId" | "termId" | "sessionId" | "startedAt" | "finishedAt" | "error">>) {
  const sets = Object.entries(patch).filter(([k]) => COLUMNS[k]);
  if (!sets.length) return;
  db.prepare(`update tasks set ${sets.map(([k]) => `${COLUMNS[k]} = ?`).join(", ")} where id = ?`).run(...sets.map(([, v]) => v ?? null), id);
}

export function insertTask(t: Task) {
  db.prepare(
    "insert into tasks (id, group_id, title, prompt, ticket, model, attempt, status, depends_on, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(t.id, t.group, t.title, t.prompt, t.ticket ?? null, t.model ?? null, t.attempt, t.status, JSON.stringify(t.dependsOn), t.createdAt);
}

// ---------- running them ----------

const FINAL = new Set<TaskStatus>(["done", "failed", "cancelled"]);

export interface NewTask {
  title: string;
  prompt?: string;
  ticket?: string;
  attempts?: number;
  model?: string;
  dependsOn?: string[];
}

export async function createTasks(input: NewTask) {
  const title = input.title?.trim();
  if (!title) throw new Error("Give the task a title");
  if (!config.repo.path) throw new Error("Set repo.path in config.local.toml first; tasks get worktrees of that repo");
  const attempts = Math.min(Math.max(Math.round(input.attempts ?? 1), 1), 4);
  let prompt = input.prompt?.trim() ?? "";
  if (!prompt && input.ticket) {
    const t = (await statusesOf([input.ticket]).catch(() => []))[0];
    prompt = `Work on ${t?.url ?? input.ticket}${t?.summary ? ` (${t.summary})` : ""}. Read the ticket first, make the change, run the checks, and commit when it's done.`;
  }
  if (!prompt) throw new Error("Say what to do, or pick a ticket");
  const known = new Set(listTasks().flatMap((t) => [t.id, t.group]));
  const dependsOn = (input.dependsOn ?? []).filter((d) => known.has(d));
  const group = randomUUID().slice(0, 8);
  for (let i = 1; i <= attempts; i++) {
    insertTask({ id: randomUUID().slice(0, 12), group, title, prompt, ticket: input.ticket || undefined, model: input.model || getSettings().tasks.defaultModel || undefined, attempt: i, status: "queued", dependsOn, createdAt: Date.now() + i });
  }
  boardChanged();
  setTimeout(() => tick().catch((e) => console.error("tasks", e)), 50);
  return groupTasks(group);
}

// how full the 5 hour limit is, from what the status line last wrote
function fivePct() {
  try {
    return db.prepare<[], { five_pct: number | null }>("select five_pct from rate_limits order by at desc limit 1").get()?.five_pct ?? 0;
  } catch {
    return 0;
  }
}

// a dependency is a task id or a whole group; it's met once every task in it is done
export function depsMet(t: Pick<Task, "dependsOn">, all: Pick<Task, "id" | "group" | "status">[]) {
  return t.dependsOn.every((d) => {
    const them = all.filter((x) => x.id === d || x.group === d);
    return them.length > 0 && them.every((x) => x.status === "done");
  });
}

// which queued tasks may start now: in order, within the slots left, and not while usage is near the limit
export function pickNext(all: Task[], maxParallel: number, usedPct: number, pauseAbove: number) {
  if (usedPct >= pauseAbove) return [];
  const active = all.filter((t) => t.status === "starting" || t.status === "running").length;
  const free = Math.max(0, maxParallel - active);
  return all
    .filter((t) => t.status === "queued" && depsMet(t, all))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, free);
}

const keyFor = (t: Task) => (t.ticket ? (t.attempt > 1 ? `${t.ticket}-${t.attempt}` : t.ticket) : `task-${t.group}${t.attempt > 1 ? `-${t.attempt}` : ""}`);

function start(t: Task) {
  updateTask(t.id, { status: "starting", startedAt: Date.now() });
  const job = createWorktree(keyFor(t), t.title, {
    ticket: t.ticket ?? "",
    onDone: (ok, path, branch, output) => {
      if (!ok || !existsSync(path)) {
        const why = output.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "the worktree command failed";
        updateTask(t.id, { status: "failed", finishedAt: Date.now(), error: `Couldn't make its worktree: ${why}` });
        notify({ title: `Task failed: ${t.title}`, body: why, link: "/board", kind: "task" });
        boardChanged();
        return;
      }
      const args = [...(t.model ? ["--model", t.model] : []), t.prompt];
      const term = spawnTerm({ cwd: path, command: "claude", args, title: `task · ${t.title}${t.attempt > 1 ? ` (${t.attempt})` : ""}` });
      updateTask(t.id, { status: "running", worktree: path, branch, termId: term.id });
      emit("task.started", { ...t, worktree: path, branch });
      boardChanged();
    },
  });
  updateTask(t.id, { jobId: job.id });
  boardChanged();
}

// a session counts as having done something once its worktree differs from where it started
async function hasChanges(worktree: string) {
  const dirty = await run("git", ["-C", worktree, "status", "--porcelain"]).catch(() => "");
  if (dirty.trim()) return true;
  const ahead = await run("git", ["-C", worktree, "rev-list", "--count", "@{upstream}..HEAD"]).catch(() => "");
  if (Number(ahead) > 0) return true;
  const base = await baseOf(worktree);
  return !!base && Number(await run("git", ["-C", worktree, "rev-list", "--count", `${base}..HEAD`]).catch(() => "0")) > 0;
}

export async function baseOf(worktree: string) {
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    const base = (await run("git", ["-C", worktree, "merge-base", "HEAD", ref]).catch(() => "")).trim();
    if (base) return base;
  }
  return undefined;
}

function finish(t: Task, status: TaskStatus, why?: string) {
  updateTask(t.id, { status, finishedAt: Date.now(), error: why });
  emit("task.done", { ...t, status });
  notify({ title: status === "done" ? `Task done: ${t.title}` : `Task failed: ${t.title}`, body: why ?? (t.attempt > 1 ? `Attempt ${t.attempt}` : "Ready for you to look at"), link: `/tasks/${t.group}`, kind: "task" });
  boardChanged();
}

async function tick() {
  const all = listTasks();
  const s = getSettings().tasks;
  // link new terminals to the claude session that starts in them
  const terms = listTerms();
  const live = listSessions({ liveOnly: true });
  for (const t of all) {
    if (t.status !== "running" || t.sessionId || !t.termId) continue;
    const term = terms.find((x) => x.id === t.termId);
    if (!term || term.exited !== undefined) {
      finish(t, "failed", "Claude exited before it got going");
      continue;
    }
    const session = live.find((x) => x.term === term.id || (!!term.pid && x.pid === term.pid));
    if (session) {
      updateTask(t.id, { sessionId: session.id, error: undefined });
      boardChanged();
      continue;
    }
    // a new worktree gets Claude's "do you trust this folder" question first; it's a checkout of a repo you
    // already trust, so say yes, otherwise leave it for you
    if (trustDialog(captureTarget(termTarget(term.id), 40))) {
      if (repoTrusted() && !trusted.has(t.id)) {
        trusted.add(t.id);
        acceptTrust(term.id);
      } else if (!t.error) {
        updateTask(t.id, { error: "Claude is asking whether to trust its folder" });
        boardChanged();
      }
    }
  }
  for (const t of pickNext(listTasks(), s.maxParallel, fivePct(), s.pauseAbovePct)) start(t);
}

const trusted = new Set<string>();

// whether Claude was told to trust the main checkout, which the worktrees are copies of
export function repoTrusted() {
  try {
    const conf = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    return !!conf.projects?.[config.repo.path]?.hasTrustDialogAccepted;
  } catch {
    return false;
  }
}

export function trustTask(id: string) {
  const t = getTask(id);
  if (!t?.termId) throw new Error("It has no terminal yet");
  trusted.add(id);
  acceptTrust(t.termId);
  updateTask(id, { error: undefined });
  boardChanged();
}

// done once its session stops with changes made and the repo's checks (when there are any) pass
async function sessionWentIdle(session: Session) {
  const t = listTasks().find((x) => x.sessionId === session.id && x.status === "running");
  if (!t?.worktree) return;
  if (!(await hasChanges(t.worktree))) return;
  if (!config.repo.verifyCommand || !getSettings().verify.auto) finish(t, "done");
}

export function cancelTask(id: string) {
  const t = getTask(id);
  if (!t || FINAL.has(t.status)) return;
  if (t.termId) kill(t.termId);
  updateTask(id, { status: "cancelled", finishedAt: Date.now() });
  boardChanged();
}

export function markDone(id: string) {
  const t = getTask(id);
  if (t && !FINAL.has(t.status)) finish(t, "done");
}

// keeps one attempt of a group; the others stop and their worktrees go
export function keepAttempt(id: string) {
  const keep = getTask(id);
  if (!keep) throw new Error("No such task");
  for (const t of groupTasks(keep.group)) {
    if (t.id === keep.id) continue;
    if (t.termId) kill(t.termId);
    if (!FINAL.has(t.status)) updateTask(t.id, { status: "cancelled", finishedAt: Date.now() });
    if (t.worktree && existsSync(t.worktree)) deleteWorktree(t.worktree);
  }
  boardChanged();
}

export function startTasks() {
  setInterval(() => tick().catch((e) => console.error("tasks", e)), 5000);
  onEvent((event, data) => {
    if (event === "session.idle") sessionWentIdle(data as Session).catch((e) => console.error("tasks", e));
    if (event === "verify.done") {
      const { worktree, ok } = data as { worktree: string; ok: boolean };
      const t = listTasks().find((x) => x.worktree === worktree && x.status === "running");
      if (t && ok) finish(t, "done");
    }
    if (event === "session.ended") {
      const t = listTasks().find((x) => x.sessionId === (data as { id: string }).id && x.status === "running");
      if (t?.worktree) hasChanges(t.worktree).then((changed) => finish(t, changed ? "done" : "failed", changed ? undefined : "Its session ended without changing anything"));
    }
  });
}
