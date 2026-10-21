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

export async function runVerify(worktree: string, force = false) {
  const command = config.repo.verifyCommand;
  if (!command) throw new Error("Set repo.verifyCommand in config.local.toml first, e.g. \"pnpm lint && pnpm test\"");
  if (!existsSync(worktree)) throw new Error("That worktree is gone");
  const last = row(worktree);
  if (last?.state === "running") return;
  const fp = await fingerprint(worktree);
  if (!force && last?.fingerprint === fp) return;
  const name = worktree.split("/").slice(-2).join("/");
  const job = startJob(`verify ${name}`, fill(command, { path: worktree, repo: config.repo.path, name }), worktree, (j) => {
    const summary = strip(j.output).trim().split("\n").slice(-40).join("\n");
    const ok = j.code === 0;
    db.prepare("update verify set state = ?, code = ?, at = ?, summary = ? where worktree = ?").run(ok ? "pass" : "fail", j.code ?? null, Date.now(), summary, worktree);
    emit("verify.done", { worktree, ok, code: j.code });
    if (!ok) notify({ title: `Checks failed in ${name}`, body: summary.split("\n").filter(Boolean).slice(-1)[0] ?? "", link: `/board?card=${encodeURIComponent(worktree)}`, kind: "verify" });
    boardChanged();
  });
  db.prepare("insert or replace into verify (worktree, state, at, code, job_id, fingerprint, summary) values (?, 'running', ?, null, ?, ?, null)").run(worktree, Date.now(), job.id, fp);
  boardChanged();
  return job;
}

// "Here's what failed", typed into the worktree's session
export async function sendFailure(worktree: string) {
  const r = db.prepare<[string], { summary: string | null }>("select summary from verify where worktree = ?").get(worktree);
  if (!r?.summary) throw new Error("No failed run to send");
  const wt = (await listWorktrees(false)).find((w) => w.path === worktree);
  const { session } = matchWorker(wt ?? { path: worktree }, [], listSessions({ limit: 800 }));
  if (!session || session.status === "ended") throw new Error("No running session in that worktree");
  const ok = await sendText(session.id, `\`${config.repo.verifyCommand}\` fails in this worktree. Fix it, then run it again to check.\n\nEnd of its output:\n${r.summary}`);
  if (!ok) throw new Error("Can't reach its terminal from here, open it and paste the output");
}

export function startVerify() {
  onEvent(async (event, data) => {
    if (event !== "session.idle" || !config.repo.verifyCommand || !getSettings().verify.auto) return;
    const s = data as Session;
    const wt = (await listWorktrees(false)).find((w) => !w.main && (s.cwd === w.path || s.cwd?.startsWith(w.path + "/")));
    if (wt) runVerify(wt.path).catch((e) => console.error("verify", e));
  });
}
