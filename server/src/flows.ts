// Flows run a recipe of steps in one worktree, each step a coding agent's turn, the repo's checks, a pause for
// you, or a list of tasks to queue. A step waits for the ones before it, can be skipped by a condition on an
// earlier step, and a step that answers "changes" can send the work back to an earlier one, a few times at most.
// Everything is kept in the run's row and moved along by a tick, so a restart picks up where it was.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Flow, FlowRun, FlowRunStep, FlowStep, Task } from "@cockpit/shared";
import { lastWords } from "./agents.ts";
import { boardChanged } from "./board.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { onEvent } from "./events.ts";
import { notify } from "./notify.ts";
import { statusesOf } from "./providers.ts";
import { getSettings } from "./settings.ts";
import { baseOf, createTasks, groupTasks } from "./tasks.ts";
import { templateFor } from "./templates.ts";
import { run as exec, slugify } from "./util.ts";
import { runVerify } from "./verify.ts";
import { agentOff } from "./workers/index.ts";
import { agentRow, sendAgent, startAgent, stopAgent } from "./workers/runner.ts";
import { createWorktree } from "./worktrees.ts";

interface Row {
  id: string;
  flow: string;
  title: string;
  prompt: string;
  ticket: string | null;
  worktree: string | null;
  branch: string | null;
  status: FlowRun["status"];
  steps: string;
  created_at: number;
  finished_at: number | null;
  error: string | null;
}

const toRun = (r: Row): FlowRun => ({
  id: r.id,
  flow: JSON.parse(r.flow),
  title: r.title,
  prompt: r.prompt,
  ticket: r.ticket ?? undefined,
  worktree: r.worktree ?? undefined,
  branch: r.branch ?? undefined,
  status: r.status,
  steps: JSON.parse(r.steps),
  createdAt: r.created_at,
  finishedAt: r.finished_at ?? undefined,
  error: r.error ?? undefined,
});

export const listFlowRuns = () => db.prepare<[], Row>("select * from flow_runs order by created_at desc limit 200").all().map(toRun);
export const getFlowRun = (id: string) => {
  const r = db.prepare<[string], Row>("select * from flow_runs where id = ?").get(id);
  return r && toRun(r);
};

function save(run: FlowRun) {
  db.prepare("update flow_runs set worktree = ?, branch = ?, status = ?, steps = ?, finished_at = ?, error = ? where id = ?").run(
    run.worktree ?? null,
    run.branch ?? null,
    run.status,
    JSON.stringify(run.steps),
    run.finishedAt ?? null,
    run.error ?? null,
    run.id,
  );
  boardChanged();
}

// ---------- reading a flow ----------

// what's wrong with a flow, or nothing
export function checkFlow(f: Flow) {
  const ids = f.steps.map((s) => s.id);
  if (!f.steps.length) return "A flow needs at least one step";
  if (new Set(ids).size !== ids.length) return "Two steps have the same id";
  for (const [i, s] of f.steps.entries()) {
    if (!/^[\w-]+$/.test(s.id)) return `"${s.id}" isn't a usable step id: letters, digits, - and _`;
    for (const a of s.after ?? []) if (ids.indexOf(a) < 0 || ids.indexOf(a) >= i) return `${s.id} waits for ${a}, which isn't a step before it`;
    if (s.loop && (ids.indexOf(s.loop.to) < 0 || ids.indexOf(s.loop.to) > i)) return `${s.id} loops back to ${s.loop.to}, which isn't it or a step before it`;
    if (s.loop && (s.kind === "human" ? false : s.output !== "verdict" && s.kind !== "verify")) return `${s.id} loops on its verdict, so it needs output: "verdict"`;
    if ((s.kind ?? "agent") !== "verify" && s.kind !== "human" && s.agent && agentOff(s.agent)) return `${s.id} uses ${s.agent}, which is turned off in Settings`;
    if (s.when && !parseWhen(s.when)) return `${s.id}'s condition "${s.when}" isn't step.verdict == value or step.status == value`;
  }
}

const deps = (f: Flow, s: FlowStep) => s.after ?? (f.steps.indexOf(s) > 0 ? [f.steps[f.steps.indexOf(s) - 1].id] : []);

// the latest round of each step, and the latest one that finished: a loop has already queued the next round of a
// review by the time the step it sent back runs, and that one wants to read the review that sent it
const current = (run: FlowRun, step: string) => run.steps.filter((x) => x.step === step).sort((a, b) => b.round - a.round)[0];
const finished = (run: FlowRun, step: string) => run.steps.filter((x) => x.step === step && x.finishedAt).sort((a, b) => b.round - a.round)[0];

// conditions are a few comparisons joined with &&, like `review.verdict == changes && tests.status != failed`
function parseWhen(when: string) {
  const parts = when.split("&&").map((p) => p.trim().match(/^([\w-]+)\.(verdict|status)\s*(==|!=)\s*["']?([\w-]+)["']?$/));
  return parts.every(Boolean) ? (parts as RegExpMatchArray[]).map((m) => ({ step: m[1], field: m[2] as "verdict" | "status", op: m[3], value: m[4] })) : undefined;
}

export function holds(run: FlowRun, when?: string) {
  if (!when) return true;
  return (parseWhen(when) ?? []).every((c) => {
    const x = current(run, c.step);
    const v = x?.[c.field] ?? "";
    return c.op === "==" ? v === c.value : v !== c.value;
  });
}

// the verdict an agent ended with; none said counts as changes, so a loop goes round rather than letting it through
export const verdictOf = (text?: string): "approve" | "changes" => {
  const all = [...(text ?? "").matchAll(/VERDICT:\s*\**\s*(approve|changes)/gi)];
  return all.length && all[all.length - 1][1].toLowerCase() === "approve" ? "approve" : "changes";
};

// the tasks an agent listed, from a ```json block or the first array in its answer
export function tasksOf(text?: string): { title: string; prompt: string; agent?: string; model?: string }[] {
  const block = text?.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/)?.[1] ?? text?.match(/\[[\s\S]*\]/)?.[0];
  try {
    const list = JSON.parse(block ?? "[]");
    return Array.isArray(list) ? list.filter((t) => typeof t?.title === "string" && typeof t?.prompt === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

// ---------- prompts ----------

const VERDICT_NOTE = "\n\nEnd your answer with a line of its own: `VERDICT: approve` when it's good to go as it is, or `VERDICT: changes` followed by what has to change.";
const TASKS_NOTE =
  '\n\nAnswer with the tasks as a JSON array in a ```json block: [{"title": "...", "prompt": "what to do and how to check it\'s done"}]. Each prompt has to stand on its own, since each task runs in a worktree of its own without this conversation. Add "agent" and "model" to a task only when it needs a particular one. Don\'t change any files.';

// what the branch changed from where it started, committed or not, new files included
async function diffOf(worktree: string) {
  const base = await baseOf(worktree);
  let text = await exec("git", ["-C", worktree, "diff", base ?? "HEAD"]).catch(() => "");
  for (const f of (await exec("git", ["-C", worktree, "ls-files", "--others", "--exclude-standard"]).catch(() => "")).split("\n").filter(Boolean).slice(0, 50)) {
    const body = await readFile(join(worktree, f), "utf8").catch(() => "");
    text += `\nNew file, not committed yet: ${f}\n${body.split("\n").slice(0, 300).join("\n")}\n`;
  }
  return text.length > 40_000 ? `${text.slice(0, 40_000)}\n… (cut, ${text.length} characters in all)` : text || "(no changes)";
}

async function promptFor(run: FlowRun, s: FlowStep, round: number) {
  let text = (round > 0 && s.again) || s.prompt || "{{prompt}}";
  const vars: Record<string, string> = { prompt: run.prompt, title: run.title, ticket: run.ticket ?? "", base: config.repo.baseBranch };
  if (text.includes("{{diff}}") && run.worktree) vars.diff = await diffOf(run.worktree);
  text = text.replace(/\{\{\s*steps\.([\w-]+)\.(output|verdict|status)\s*\}\}/g, (_, id: string, f: "output" | "verdict" | "status") => finished(run, id)?.[f] ?? "");
  text = text.replace(/\{\{\s*(prompt|title|ticket|base|diff)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
  if (s.kind === "tasks") return text + TASKS_NOTE;
  if (s.output === "verdict") text += VERDICT_NOTE;
  if (s.access !== "readonly") text += `\n\nYou're working in a worktree on its own branch, which starts from \`${config.repo.baseBranch}\`. Commit your work as you go. Only open a PR when this asks you to, and then target \`${config.repo.baseBranch}\`.`;
  return text;
}

// ---------- running ----------

const agentOf = (s: FlowStep) => s.agent || getSettings().tasks.defaultAgent || "claude";

async function start(run: FlowRun, s: FlowStep, rs: FlowRunStep) {
  rs.status = "running";
  rs.startedAt = Date.now();
  const kind = s.kind ?? "agent";
  if (kind === "human") {
    rs.status = "waiting";
    notify({ title: `Flow waiting for you: ${run.title}`, body: s.name ?? s.id, link: `/flows/${run.id}`, kind: "flow" });
    return;
  }
  if (kind === "verify") {
    if (!config.repo.verifyCommand) return finish(run, s, rs, { status: "skipped", output: "repo.verifyCommand isn't set" });
    const job = await runVerify(run.worktree!, true);
    rs.jobId = job?.id;
    return;
  }
  const prompt = await promptFor(run, s, rs.round);
  const before = run.steps.filter((x) => x.step === s.id && x.round < rs.round && x.sessionId).sort((a, b) => b.round - a.round)[0];
  // a step that runs again goes on with its own conversation, so it remembers what it did
  if (before?.sessionId && agentRow(before.sessionId)?.agent === agentOf(s) && sendAgent(before.sessionId, prompt)) {
    rs.sessionId = before.sessionId;
    return;
  }
  rs.sessionId = startAgent({ agent: agentOf(s), cwd: run.worktree!, prompt, model: s.model, access: s.access ?? (kind === "tasks" ? "readonly" : "sandbox"), title: `${run.title} · ${s.name ?? s.id}` });
}

function finish(run: FlowRun, s: FlowStep, rs: FlowRunStep, r: { status: FlowRunStep["status"]; output?: string; verdict?: FlowRunStep["verdict"] }) {
  Object.assign(rs, r, { finishedAt: Date.now() });
  if (rs.status !== "done" || rs.verdict !== "changes" || !s.loop) return;
  const rounds = run.steps.filter((x) => x.step === s.loop!.to).length;
  if (rounds > s.loop.max) return;
  // back to the step it names: that one and every one up to this go again, a round later
  const from = run.flow.steps.findIndex((x) => x.id === s.loop!.to);
  const to = run.flow.steps.indexOf(s);
  for (const again of run.flow.steps.slice(from, to + 1)) run.steps.push({ step: again.id, round: (current(run, again.id)?.round ?? -1) + 1, status: "pending" });
}

// how a running step is doing: still going, or done with what it gave
async function check(run: FlowRun, s: FlowStep, rs: FlowRunStep) {
  const kind = s.kind ?? "agent";
  if (kind === "verify") {
    const v = db.prepare<[string], { state: string; summary: string | null; at: number }>("select state, summary, at from verify where worktree = ?").get(run.worktree!);
    if (!v || v.state === "running" || v.at < (rs.startedAt ?? 0)) return;
    return finish(run, s, rs, { status: "done", output: v.summary ?? "", verdict: v.state === "pass" ? "approve" : "changes" });
  }
  if (kind === "tasks" && rs.tasks) {
    const all = rs.tasks.flatMap((g) => groupTasks(g));
    if (all.some((t) => !["done", "failed", "cancelled"].includes(t.status))) return;
    return finish(run, s, rs, { status: all.some((t) => t.status === "done") ? "done" : "failed", output: all.map((t) => `- ${t.title}: ${t.status}${t.branch ? ` (${t.branch})` : ""}`).join("\n") });
  }
  if (!rs.sessionId) return;
  const row = agentRow(rs.sessionId);
  if (!row) return finish(run, s, rs, { status: "failed", output: "Its session is gone" });
  if (row.status === "busy") return;
  // a turn that began after the step started has ended
  if (row.updated_at < (rs.startedAt ?? 0)) return;
  const text = (await lastWords(rs.sessionId)).text;
  if (row.error) return finish(run, s, rs, { status: "failed", output: row.error });
  if (kind === "tasks") {
    const list = tasksOf(text);
    if (!list.length) return finish(run, s, rs, { status: "failed", output: `${text ?? ""}\n\n(No list of tasks in that answer.)` });
    const made: Task[][] = [];
    for (const t of list) made.push(await createTasks({ title: t.title, prompt: t.prompt, ticket: run.ticket, agent: t.agent, model: t.model }));
    rs.tasks = made.map((g) => g[0].group);
    rs.output = text;
    return;
  }
  return finish(run, s, rs, { status: "done", output: text ?? "", verdict: s.output === "verdict" ? verdictOf(text) : undefined });
}

const ticking = new Set<string>();

// moves one run along as far as it can go now
export async function advance(id: string) {
  if (ticking.has(id)) return;
  ticking.add(id);
  try {
    const run = getFlowRun(id);
    if (!run || !["running", "waiting"].includes(run.status)) return;
    const was = JSON.stringify(run);
    const f = run.flow;
    for (const s of f.steps) {
      const rs = current(run, s.id);
      if (rs?.status === "running") await check(run, s, rs);
    }
    for (const s of f.steps) {
      const rs = current(run, s.id);
      if (rs?.status !== "pending") continue;
      const ready = deps(f, s).every((d) => ["done", "skipped"].includes(current(run, d)?.status ?? ""));
      if (!ready) continue;
      if (!holds(run, s.when)) {
        Object.assign(rs, { status: "skipped", finishedAt: Date.now() });
        continue;
      }
      await start(run, s, rs);
    }
    const now = f.steps.map((s) => current(run, s.id));
    const failed = now.find((x) => x?.status === "failed");
    if (failed) {
      run.status = "failed";
      run.error = `${failed.step} failed`;
      run.finishedAt = Date.now();
      notify({ title: `Flow failed: ${run.title}`, body: `At ${failed.step}: ${(failed.output ?? "").split("\n")[0].slice(0, 160)}`, link: `/flows/${run.id}`, kind: "flow" });
    } else if (now.every((x) => x && ["done", "skipped"].includes(x.status))) {
      run.status = "done";
      run.finishedAt = Date.now();
      notify({ title: `Flow done: ${run.title}`, body: f.name, link: `/flows/${run.id}`, kind: "flow" });
    } else {
      run.status = now.some((x) => x?.status === "waiting") && !now.some((x) => x?.status === "running") ? "waiting" : "running";
    }
    if (JSON.stringify(run) !== was) save(run);
  } finally {
    ticking.delete(id);
  }
}

export interface NewFlowRun {
  flow: string;
  title: string;
  prompt?: string;
  ticket?: string;
}

export async function startFlow(input: NewFlowRun) {
  const flow = getSettings().flows.find((f) => f.id === input.flow) as Flow | undefined;
  if (!flow) throw Object.assign(new Error(`No flow called ${input.flow}`), { status: 400 });
  const bad = checkFlow(flow);
  if (bad) throw Object.assign(new Error(bad), { status: 400 });
  const title = input.title?.trim();
  if (!title) throw Object.assign(new Error("Give it a title"), { status: 400 });
  if (!config.repo.path) throw Object.assign(new Error("Set repo.path in config.local.toml first; flows work in a worktree of that repo"), { status: 400 });
  let prompt = input.prompt?.trim() ?? "";
  const ticket = input.ticket ? (await statusesOf([input.ticket]).catch(() => []))[0] : undefined;
  if (!prompt && input.ticket) prompt = `Work on ${ticket?.url ?? input.ticket}${ticket?.summary ? ` (${ticket.summary})` : ""}. Read the ticket first.`;
  if (!prompt) throw Object.assign(new Error("Say what to do, or pick a ticket"), { status: 400 });
  const id = randomUUID().slice(0, 8);
  const run: FlowRun = { id, flow, title, prompt, ticket: input.ticket, status: "starting", steps: flow.steps.map((s) => ({ step: s.id, round: 0, status: "pending" })), createdAt: Date.now() };
  db.prepare("insert into flow_runs (id, flow, title, prompt, ticket, status, steps, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)").run(id, JSON.stringify(flow), title, prompt, input.ticket ?? null, run.status, JSON.stringify(run.steps), run.createdAt);
  const key = input.ticket ? `${input.ticket}-flow-${id.slice(0, 4)}` : `flow-${id}`;
  createWorktree(key, slugify(title) || "flow", {
    ticket: input.ticket ?? "",
    template: templateFor({ summary: ticket?.summary ?? title, type: ticket?.type }),
    onDone: (ok, path, branch, output) => {
      const r = getFlowRun(id)!;
      if (!ok || !existsSync(path)) {
        r.status = "failed";
        r.error = `Couldn't make its worktree: ${output.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "the worktree command failed"}`;
        r.finishedAt = Date.now();
        return save(r);
      }
      Object.assign(r, { status: "running", worktree: path, branch });
      save(r);
      void advance(id);
    },
  });
  boardChanged();
  return getFlowRun(id)!;
}

// a human step: carry on, or send the work back as if a review had asked for changes
export async function answerStep(id: string, step: string, verdict: "approve" | "changes", note?: string) {
  const run = getFlowRun(id);
  const s = run?.flow.steps.find((x) => x.id === step);
  const rs = run && current(run, step);
  if (!run || !s || rs?.status !== "waiting") throw Object.assign(new Error("That step isn't waiting for you"), { status: 400 });
  finish(run, s, rs, { status: "done", verdict, output: note?.trim() || (verdict === "approve" ? "Approved" : "Sent back") });
  run.status = "running";
  save(run);
  await advance(id);
  return getFlowRun(id);
}

export function cancelFlow(id: string) {
  const run = getFlowRun(id);
  if (!run || ["done", "failed", "cancelled"].includes(run.status)) return run;
  for (const rs of run.steps) {
    if (rs.status !== "running" && rs.status !== "waiting" && rs.status !== "pending") continue;
    if (rs.status === "running" && rs.sessionId) stopAgent(rs.sessionId);
    rs.status = rs.status === "pending" ? "skipped" : "failed";
  }
  Object.assign(run, { status: "cancelled", finishedAt: Date.now() });
  save(run);
  return run;
}

// whether a worktree is a running flow's, so the automatic checks leave it to the flow
export const inFlow = (worktree: string) => listFlowRuns().some((r) => r.worktree === worktree && ["running", "waiting"].includes(r.status));

export function startFlows() {
  const tick = () => {
    for (const r of listFlowRuns()) if (r.status === "running" || r.status === "waiting") void advance(r.id).catch((e) => console.error("flows", e));
  };
  setInterval(tick, 3000);
  onEvent((event, data) => {
    if (event !== "session.idle" && event !== "verify.done" && event !== "task.done") return;
    const d = data as { id?: string; worktree?: string; group?: string };
    for (const r of listFlowRuns()) {
      if (r.status !== "running") continue;
      if (r.steps.some((s) => (d.id && s.sessionId === d.id) || (d.worktree && r.worktree === d.worktree) || (d.group && s.tasks?.includes(d.group)))) void advance(r.id).catch((e) => console.error("flows", e));
    }
  });
}
