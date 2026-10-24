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
import { parsePr, statusesOf } from "./providers.ts";
import { kill, listTerms, spawnTerm } from "./pty.ts";
import { getSettings } from "./settings.ts";
import { run } from "./util.ts";
import { nightOn } from "./overnight.ts";
import { basePr, stackedNote, stackOnto } from "./stacked.ts";
import { promptFor, templateFor } from "./templates.ts";
import { createWorktree, deleteWorktree } from "./worktrees.ts";
import { agentOff, agentProvider } from "./workers/index.ts";
import { agentRow, closeAgent, startAgent } from "./workers/runner.ts";

interface Row {
  id: string;
  group_id: string;
  title: string;
  prompt: string;
  ticket: string | null;
  agent: string | null;
  model: string | null;
  template: string | null;
  on_pr: string | null;
  base: string | null;
  overnight: number;
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
  agent: r.agent ?? undefined,
  model: r.model ?? undefined,
  template: r.template ?? undefined,
  onPr: r.on_pr ?? undefined,
  base: r.base ?? undefined,
  overnight: !!r.overnight || undefined,
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
    "insert into tasks (id, group_id, title, prompt, ticket, agent, model, template, on_pr, base, overnight, attempt, status, depends_on, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(t.id, t.group, t.title, t.prompt, t.ticket ?? null, t.agent ?? null, t.model ?? null, t.template ?? null, t.onPr ?? null, t.base ?? null, t.overnight ? 1 : 0, t.attempt, t.status, JSON.stringify(t.dependsOn), t.createdAt);
}

// ---------- running them ----------

const FINAL = new Set<TaskStatus>(["done", "failed", "cancelled"]);

export interface NewTask {
  title: string;
  prompt?: string;
  ticket?: string;
  attempts?: number;
  // the coding agent and model for every attempt; Claude Code when no agent is given
  agent?: string;
  model?: string;
  // or one attempt per entry, each with its own agent and model, to compare them
  lineup?: { agent?: string; model?: string }[];
  dependsOn?: string[];
  // a kind of work by id; without one it's picked by the ticket
  template?: string;
  // where to start instead of the repo's base branch: a teammate's open PR (link or number), or a branch on origin
  onPr?: string;
  // hold it for the overnight queue
  overnight?: boolean;
}

// Claude Code in its terminal is the default, kept as no agent at all
const agentId = (a?: string) => (a && a !== "claude" ? a : undefined);

export async function createTasks(input: NewTask) {
  const title = input.title?.trim();
  if (!title) throw new Error("Give the task a title");
  if (!config.repo.path) throw new Error("Set repo.path in config.local.toml first; tasks get worktrees of that repo");
  const lineup = input.lineup?.length ? input.lineup.slice(0, 4) : undefined;
  const attempts = lineup?.length ?? Math.min(Math.max(Math.round(input.attempts ?? 1), 1), 4);
  let prompt = input.prompt?.trim() ?? "";
  const ticket = input.ticket ? (await statusesOf([input.ticket]).catch(() => []))[0] : undefined;
  const tpl = templateFor({ summary: ticket?.summary ?? title, type: ticket?.type }, input.template);
  if (!prompt && input.ticket) {
    prompt =
      promptFor(tpl, { key: input.ticket, url: ticket?.url, summary: ticket?.summary }) ??
      `Work on ${ticket?.url ?? input.ticket}${ticket?.summary ? ` (${ticket.summary})` : ""}. Read the ticket first, make the change, run the checks, and commit when it's done.`;
  }
  if (!prompt) throw new Error("Say what to do, or pick a ticket");
  // checked now, so a closed or unknown PR or branch is said straight away rather than when the task starts
  const { onPr, base } = await startPoint(input.onPr?.trim() ?? "");
  const known = new Set(listTasks().flatMap((t) => [t.id, t.group]));
  const dependsOn = (input.dependsOn ?? []).filter((d) => known.has(d));
  const group = randomUUID().slice(0, 8);
  const s = getSettings().tasks;
  for (let i = 1; i <= attempts; i++) {
    const pick = lineup?.[i - 1] ?? input;
    // a model only goes with the agent it was given for; Claude's default model isn't Codex's
    // empty falls back to the kind of work's agent, then the default; "claude" is Claude Code in its terminal
    const agent = agentId(pick.agent || input.agent || tpl?.agent || s.defaultAgent);
    if (agent && !agentProvider(agent)) throw Object.assign(new Error(`No agent called ${agent}`), { status: 400 });
    if (agent && agentOff(agent)) throw Object.assign(new Error(`${agentProvider(agent)!.name} is turned off in Settings → Board and automation`), { status: 400 });
    const model = pick.model || (agentId(tpl?.agent) === agent ? tpl?.model : "") || (agentId(s.defaultAgent) === agent ? s.defaultModel : "") || undefined;
    insertTask({ id: randomUUID().slice(0, 12), group, title, prompt, ticket: input.ticket || undefined, agent, model, template: tpl?.id, onPr, base, overnight: !!input.overnight || undefined, attempt: i, status: "queued", dependsOn, createdAt: Date.now() + i });
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

// which queued tasks may start now: in order, within the slots left, and not while usage is near the limit;
// Claude's 5 hour limit only holds back tasks on Claude
export function pickNext(all: Task[], maxParallel: number, usedPct: number, pauseAbove: number) {
  const paused = usedPct >= pauseAbove;
  const active = all.filter((t) => t.status === "starting" || t.status === "running").length;
  const free = Math.max(0, maxParallel - active);
  return all
    .filter((t) => t.status === "queued" && (!paused || !!t.agent) && depsMet(t, all))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, free);
}

// nobody is there to answer overnight, so it shouldn't wait on anyone
const NIGHT_NOTE = "\n\nThis runs overnight while I'm away, so don't stop to ask me anything: make the sensible choice and note it. If something blocks you, say what and why in your last message and stop. Commit your work, but don't push or open a PR; I'll look in the morning.";

const keyFor = (t: Task) => (t.ticket ? (t.attempt > 1 ? `${t.ticket}-${t.attempt}` : t.ticket) : `task-${t.group}${t.attempt > 1 ? `-${t.attempt}` : ""}`);

function start(t: Task) {
  updateTask(t.id, { status: "starting", startedAt: Date.now() });
  let job: ReturnType<typeof createWorktree>;
  try {
    job = createWorktree(keyFor(t), t.title, {
      ticket: t.ticket ?? "",
      template: t.template ? templateFor({}, t.template) : templateFor({ summary: t.title }),
      onDone: (ok, path, branch, output) => {
        if (!ok || !existsSync(path)) {
          const why = output.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "the worktree command failed";
          updateTask(t.id, { status: "failed", finishedAt: Date.now(), error: `Couldn't make its worktree: ${why}` });
          notify({ title: `Task failed: ${t.title}`, body: why, link: "/board", kind: "task" });
          boardChanged();
          return;
        }
        void (async () => {
          let prompt = t.prompt + (t.overnight ? NIGHT_NOTE : "");
          try {
            prompt += await placeAt(path, t);
          } catch (e) {
            updateTask(t.id, { status: "failed", finishedAt: Date.now(), worktree: path, branch, error: (e as Error).message });
            boardChanged();
            return;
          }
          const title = `${t.title}${t.attempt > 1 ? ` (${t.attempt})` : ""}`;
          if (t.agent) {
            // another agent runs a turn at a time without a terminal; its session is there from the start
            try {
              const sessionId = startAgent({ agent: t.agent, cwd: path, prompt, model: t.model, title });
              updateTask(t.id, { status: "running", worktree: path, branch, sessionId });
            } catch (e) {
              updateTask(t.id, { status: "failed", finishedAt: Date.now(), worktree: path, branch, error: (e as Error).message });
              boardChanged();
              return;
            }
          } else {
            const args = [...(t.model ? ["--model", t.model] : []), prompt];
            const term = spawnTerm({ cwd: path, command: "claude", args, title: `task · ${title}` });
            updateTask(t.id, { status: "running", worktree: path, branch, termId: term.id });
          }
          emit("task.started", { ...t, worktree: path, branch });
          boardChanged();
        })().catch((e) => console.error("tasks", e));
      },
    });
  } catch (e) {
    updateTask(t.id, { status: "failed", finishedAt: Date.now(), error: (e as Error).message });
    boardChanged();
    return;
  }
  updateTask(t.id, { jobId: job.id });
  boardChanged();
}

// Puts a new worktree where its work starts: on a PR it builds on, another branch, or the base branch it was made
// from. What comes back is what the agent is told about it, its PR's target above all.
export async function placeAt(path: string, at: { onPr?: string; base?: string }) {
  if (at.onPr) {
    try {
      const s = await stackOnto(path, at.onPr);
      return stackedNote({ n: s.ref.n, title: s.info.title, author: s.info.author, branch: s.info.headRefName! });
    } catch (e) {
      throw new Error(`Couldn't start it on ${at.onPr}: ${(e as Error).message}`);
    }
  }
  if (at.base) {
    const git = (...a: string[]) => run("git", ["-C", path, ...a]);
    try {
      await git("fetch", "origin", at.base);
      await git("reset", "--hard", `origin/${at.base}`);
    } catch (e) {
      throw new Error(`Couldn't start it on ${at.base}: ${(e as Error).message}`);
    }
  }
  const target = at.base ?? config.repo.baseBranch;
  return `\n\nThis branch starts from \`${target}\`. When you open the PR, target it: \`--base ${target}\`.`;
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
  for (const ref of [`origin/${config.repo.baseBranch}`, "origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    const base = (await run("git", ["-C", worktree, "merge-base", "HEAD", ref]).catch(() => "")).trim();
    if (base) return base;
  }
  return undefined;
}

// What "start from" says: a PR to build on, another branch, or nothing (the base branch, also when it's named)
export async function startPoint(input: string): Promise<{ onPr?: string; base?: string }> {
  if (!input || input === config.repo.baseBranch || input === `origin/${config.repo.baseBranch}`) return {};
  if (parsePr(input)) return { onPr: (await basePr(input)).info.url };
  const branch = input.replace(/^origin\//, "");
  const ok = /^[\w./-]+$/.test(branch) && !!(await run("git", ["-C", config.repo.path, "ls-remote", "--heads", "origin", branch]).catch(() => "")).trim();
  if (!ok) throw Object.assign(new Error(`${input} isn't a PR link or number, or a branch on origin`), { status: 400 });
  return { base: branch };
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
  // overnight tasks wait for the night, out of the list rather than counted as running
  const night = nightOn();
  for (const t of pickNext(listTasks().filter((x) => night || !x.overnight || x.status !== "queued"), s.maxParallel, fivePct(), s.pauseAbovePct)) start(t);
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
  // after it's marked, so its session ending doesn't count as the task finishing
  if (t.sessionId && agentRow(t.sessionId)) closeAgent(t.sessionId);
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
    if (t.sessionId && agentRow(t.sessionId)) closeAgent(t.sessionId);
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
