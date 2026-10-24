// Runs the repo's own checks (repo.verifyCommand, e.g. lint and tests) in a worktree when its session finishes
// a turn, so a card says whether the work holds up before you look at it.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Session } from "@cockpit/shared";
import { sendText } from "./agents.ts";
import { boardChanged, matchWorker } from "./board.ts";
import { listSessions } from "./claude/sessions.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { emit, onEvent } from "./events.ts";
import { startJob } from "./jobs.ts";
import { notify } from "./notify.ts";
import { appendLog, finishRun, getRun, outputTail, startRun } from "./runs.ts";
import { getSettings } from "./settings.ts";
import { fill, run } from "./util.ts";
import { listWorktrees } from "./worktrees.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

// HEAD plus what's uncommitted: when neither moved, the last result still stands
async function fingerprint(worktree: string) {
  const head = await run("git", ["-C", worktree, "rev-parse", "HEAD"]).catch(() => "");
  const dirty = await run("git", ["-C", worktree, "status", "--porcelain"]).catch(() => "");
  const diff = dirty.trim() ? await run("git", ["-C", worktree, "diff", "HEAD"]).catch(() => "") : "";
  return createHash("sha1").update(head + dirty + diff).digest("hex");
}

const row = (worktree: string) => db.prepare<[string], { state: string; fingerprint: string | null }>("select state, fingerprint from verify where worktree = ?").get(worktree);

// undefined when it's already running, or nothing changed since the last time (unless forced)
export async function runVerify(worktree: string, force = false) {
  const command = config.repo.verifyCommand;
  if (!command) throw new Error("Set repo.verifyCommand in config.local.toml first, e.g. \"pnpm lint && pnpm test\"");
  if (!existsSync(worktree)) throw new Error("That worktree is gone");
  const last = row(worktree);
  if (last?.state === "running") return;
  const fp = await fingerprint(worktree);
  if (!force && last?.fingerprint === fp) return;
  const name = worktree.split("/").slice(-2).join("/");
  const cmd = fill(command, { path: worktree, repo: config.repo.path, name });
  // the verify row stays the latest result; every run also lands on the Runs screen
  const rec = startRun({ kind: "verify", name: `verify ${name}`, worktree, cwd: worktree, command: cmd }, "verify");
  const job = startJob(`verify ${name}`, cmd, worktree, (j) => {
    const summary = strip(j.output).trim().split("\n").slice(-40).join("\n");
    const ok = j.code === 0;
    appendLog(rec.id, strip(j.output).split("\n"));
    finishRun(rec.id, { exitCode: j.code ?? 1 });
    db.prepare("update verify set state = ?, code = ?, at = ?, summary = ? where worktree = ?").run(ok ? "pass" : "fail", j.code ?? null, Date.now(), summary, worktree);
    emit("verify.done", { worktree, ok, code: j.code });
    if (!ok) notify({ title: `Checks failed in ${name}`, body: summary.split("\n").filter(Boolean).slice(-1)[0] ?? "", link: `/board?card=${encodeURIComponent(worktree)}`, kind: "verify" });
    boardChanged();
  });
  setJob(rec.id, job.id);
  db.prepare("insert or replace into verify (worktree, state, at, code, job_id, fingerprint, summary) values (?, 'running', ?, null, ?, ?, null)").run(worktree, Date.now(), job.id, fp);
  boardChanged();
  // the run too, for whoever started it and wants to open it
  return { id: job.id, runId: rec.id };
}

// the job's id, so the run's page can follow its output live
const setJob = (id: string, job: string) => db.prepare("update runs set meta = json_set(meta, '$.job', ?) where id = ?").run(job, id);

// Types text into the session working in a worktree, or into the session given when it's still running
export async function sendToWorker(text: string, worktree?: string, sessionId?: string) {
  const sessions = listSessions({ limit: 800 });
  let session = sessionId ? sessions.find((s) => s.id === sessionId && s.status !== "ended") : undefined;
  if (!session && worktree) {
    const wt = (await listWorktrees(false)).find((w) => w.path === worktree);
    session = matchWorker(wt ?? { path: worktree }, [], sessions).session;
  }
  if (!session || session.status === "ended") throw new Error(worktree ? "No running session in that worktree" : "No running session to send it to");
  const ok = await sendText(session.id, text);
  if (!ok) throw new Error("Can't reach its terminal from here, open it and paste the output");
}

// "Here's what failed", typed into the worktree's session
export async function sendFailure(worktree: string) {
  const r = db.prepare<[string], { summary: string | null }>("select summary from verify where worktree = ?").get(worktree);
  if (!r?.summary) throw new Error("No failed run to send");
  await sendToWorker(`\`${config.repo.verifyCommand}\` fails in this worktree. Fix it, then run it again to check.\n\nEnd of its output:\n${r.summary}`, worktree);
}

// The same for any run on the Runs screen: to the session that ran it, else the one in its worktree
export async function sendRunFailure(id: string) {
  const r = getRun(id);
  if (!r) throw new Error("No such run");
  if (r.status !== "fail") throw new Error("That run didn't fail");
  const tail = outputTail(id, 40).join("\n").trim();
  const what = r.command ? `\`${r.command}\`` : r.name;
  const failing = r.summary.failing?.length ? `\n\nFailing:\n${r.summary.failing.map((f) => `- ${f}`).join("\n")}` : "";
  const url = typeof r.meta.url === "string" ? `\n\n${r.meta.url}` : "";
  await sendToWorker(`${what} fails${r.worktree ? " in this worktree" : ""}. Fix it, then run it again to check.${failing}${url}${tail ? `\n\nEnd of its output:\n${tail}` : ""}`, r.worktree, r.meta.session);
}

export function startVerify() {
  onEvent(async (event, data) => {
    if (event !== "session.idle" || !config.repo.verifyCommand || !getSettings().verify.auto) return;
    const s = data as Session;
    const wt = (await listWorktrees(false)).find((w) => !w.main && (s.cwd === w.path || s.cwd?.startsWith(w.path + "/")));
    if (wt) runVerify(wt.path).catch((e) => console.error("verify", e));
  });
}
