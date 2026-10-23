// "Passes here, fails in CI": runs a failing CI check's job in the worktree and keeps both results side by side,
// with what's worth comparing (which commit each ran on, tool versions, CI-only env), so working out why they
// differ starts from one place instead of copying logs around.
import { existsSync } from "node:fs";
import { boardChanged, matchWorker } from "./board.ts";
import { listSessions } from "./claude/sessions.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { startJob } from "./jobs.ts";
import { notify } from "./notify.ts";
import { failingChecks, myPrs } from "./providers.ts";
import { scriptCommand, scriptsIn } from "./runnable.ts";
import { appendLog, finishRun, kindOf, startRun, strip } from "./runs.ts";
import { getSettings } from "./settings.ts";
import { fill, run } from "./util.ts";
import { sendToWorker } from "./verify.ts";
import { listWorktrees } from "./worktrees.ts";

db.exec(`
  create table if not exists ci_compare (
    worktree text primary key,
    pr integer not null,
    check_name text not null,
    ci_link text,
    ci_tail text,
    ci_sha text,
    command text not null,
    local_sha text,
    local_dirty integer not null default 0,
    env text,
    state text not null,
    code integer,
    local_tail text,
    run_id text,
    job_id text,
    at integer not null
  );
`);

export interface CiCompare {
  worktree: string;
  pr: number;
  check: string;
  ciLink?: string;
  ciTail: string;
  ciSha?: string;
  command: string;
  localSha?: string;
  localDirty: boolean;
  env: string[];
  state: "running" | "done";
  code?: number;
  localTail?: string;
  runId?: string;
  jobId?: string;
  at: number;
  // passes-here: the case this is for; fails-both: it's just broken, fix it as usual
  verdict?: "passes-here" | "fails-both";
}

interface Row {
  worktree: string;
  pr: number;
  check_name: string;
  ci_link: string | null;
  ci_tail: string | null;
  ci_sha: string | null;
  command: string;
  local_sha: string | null;
  local_dirty: number;
  env: string | null;
  state: string;
  code: number | null;
  local_tail: string | null;
  run_id: string | null;
  job_id: string | null;
  at: number;
}

const toCompare = (r: Row): CiCompare => ({
  worktree: r.worktree,
  pr: r.pr,
  check: r.check_name,
  ciLink: r.ci_link ?? undefined,
  ciTail: r.ci_tail ?? "",
  ciSha: r.ci_sha ?? undefined,
  command: r.command,
  localSha: r.local_sha ?? undefined,
  localDirty: !!r.local_dirty,
  env: JSON.parse(r.env || "[]"),
  state: r.state as CiCompare["state"],
  code: r.code ?? undefined,
  localTail: r.local_tail ?? undefined,
  runId: r.run_id ?? undefined,
  jobId: r.job_id ?? undefined,
  at: r.at,
  verdict: r.state !== "done" ? undefined : r.code === 0 ? "passes-here" : "fails-both",
});

export const getCompare = (worktree: string) => {
  const r = db.prepare<[string], Row>("select * from ci_compare where worktree = ?").get(worktree);
  return r ? toCompare(r) : null;
};

const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
const glob = (p: string) => new RegExp(`^${p.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");

// "lint (18.x)" or "ci / unit-tests" is named after the job; the part a script would be named after
export const jobWord = (check: string) =>
  check
    .replace(/\s*\(.*\)\s*$/, "")
    .split("/")
    .at(-1)!
    .trim()
    .toLowerCase();

// The command that runs a check here: the settings' line for it, else the root package.json script named like the
// job, else the repo's verify command
export function localCommand(check: string, lines: string[], scripts: { rel: string; name: string; runner: string }[], verify: string) {
  for (const line of lines) {
    const at = line.indexOf("=");
    if (at < 1) continue;
    if (glob(line.slice(0, at)).test(check)) return { command: line.slice(at + 1).trim(), from: "settings" as const };
  }
  const word = jobWord(check);
  const root = scripts.filter((s) => s.rel === ".");
  const script = root.find((s) => s.name.toLowerCase() === word) ?? root.find((s) => s.name.toLowerCase() === word.replace(/s$/, ""));
  if (script) return { command: scriptCommand(script), from: "script" as const };
  if (verify) return { command: verify, from: "verify" as const };
}

// what can make the same job behave differently here, worth putting next to the two results
async function envHere(worktree: string) {
  const v = (cmd: string, args: string[]) => run(cmd, args, { cwd: worktree }).then((o) => o.trim().split("\n")[0], () => "not found");
  const [node, pnpm, npm, python] = await Promise.all([v("node", ["--version"]), v("pnpm", ["--version"]), v("npm", ["--version"]), v("python3", ["--version"])]);
  return [
    `node ${node}`,
    `pnpm ${pnpm}`,
    `npm ${npm}`,
    python,
    `${process.platform} ${process.arch}`,
    `TZ=${process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `LANG=${process.env.LANG ?? "unset"}`,
    `CI=${process.env.CI ?? "unset"} (CI sets it, and some tools change with it)`,
  ];
}

export async function startCompare(worktree: string, check?: string) {
  const wt = (await listWorktrees(false)).find((w) => w.path === worktree);
  if (!wt || !existsSync(wt.path)) throw bad("That isn't a worktree cockpit knows");
  if (getCompare(worktree)?.state === "running") throw bad("It's already running here", 409);
  const { pr } = matchWorker(wt, await myPrs(), listSessions({ limit: 800 }));
  if (!pr || pr.state !== "OPEN") throw bad("Its PR isn't open, so there are no CI checks to compare with");
  const failing = await failingChecks(pr.number);
  if (!failing.length) throw bad(`Nothing is failing on #${pr.number} right now`);
  const c = (check && failing.find((f) => f.name === check)) || failing[0];
  const found = localCommand(c.name, getSettings().ci.local, scriptsIn(wt.path, 0), config.repo.verifyCommand);
  if (!found) throw bad(`Cockpit doesn't know how to run "${c.name}" here. Add a line for it in Settings → Board and automation → CI checks here, like "${c.name} = pnpm test".`);
  const name = wt.path.split("/").slice(-2).join("/");
  const command = fill(found.command, { path: wt.path, repo: config.repo.path, name });
  const [sha, dirty, env] = await Promise.all([run("git", ["-C", wt.path, "rev-parse", "HEAD"]).then((o) => o.trim(), () => ""), run("git", ["-C", wt.path, "status", "--porcelain"]).then((o) => !!o.trim(), () => false), envHere(wt.path)]);

  const rec = startRun({ kind: kindOf(command) ?? "ci", name: `${c.name}, here`, worktree: wt.path, cwd: wt.path, command, ticket: wt.ticket, meta: { pr: pr.number, ciCheck: c.name, url: c.link } }, "ci-compare");
  const job = startJob(`${c.name} here`, command, wt.path, (j) => {
    const out = strip(j.output);
    appendLog(rec.id, out.split("\n"));
    finishRun(rec.id, { exitCode: j.code ?? 1 });
    db.prepare("update ci_compare set state = 'done', code = ?, local_tail = ? where worktree = ? and run_id = ?").run(j.code ?? 1, out.trim().split("\n").slice(-80).join("\n"), wt.path, rec.id);
    const passes = j.code === 0;
    notify({ title: passes ? `${c.name} passes here, fails in CI` : `${c.name} fails here too`, body: passes ? "The difference is in CI's setup. Compare them on the Board." : "It's broken here as well, so fix it the usual way.", link: `/board?card=${encodeURIComponent(wt.path)}`, kind: "verify" });
    boardChanged();
  });
  db.prepare(
    `insert or replace into ci_compare (worktree, pr, check_name, ci_link, ci_tail, ci_sha, command, local_sha, local_dirty, env, state, code, local_tail, run_id, job_id, at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', null, null, ?, ?, ?)`,
  ).run(wt.path, pr.number, c.name, c.link, c.tail, pr.headSha ?? null, command, sha || null, dirty ? 1 : 0, JSON.stringify(env), rec.id, job.id, Date.now());
  boardChanged();
  return getCompare(wt.path)!;
}

// what the worktree's Claude gets: both ends, and what to look at
export function comparePrompt(c: CiCompare) {
  const same = c.ciSha && c.localSha && c.ciSha === c.localSha;
  const commits = same
    ? `Both ran on ${c.localSha!.slice(0, 12)}${c.localDirty ? ", plus uncommitted changes here" : ""}.`
    : `CI ran on ${c.ciSha?.slice(0, 12) ?? "the PR's head"} and here is ${c.localSha?.slice(0, 12) ?? "unknown"}${c.localDirty ? " with uncommitted changes" : ""}, so part of the difference may just be the code.`;
  return [
    `The CI check "${c.check}" on PR #${c.pr} fails, but \`${c.command}\` passes in this worktree. Work out why they differ, then fix the real cause rather than the symptom. ${commits}`,
    `Look at what CI does differently: the workflow file for this job (its steps, env, matrix and versions), clean installs against this checkout's node_modules, caches, files that are gitignored or generated here, test order and parallelism, time zone, locale, the CI env var, and anything that needs network or secrets.`,
    `This machine: ${c.env.join(", ")}.`,
    `End of CI's log${c.ciLink ? ` (${c.ciLink})` : ""}:\n${c.ciTail.trim() || "(empty)"}`,
    `End of the run here:\n${c.localTail?.trim() || "(empty)"}`,
    "(Sent by cockpit.)",
  ].join("\n\n");
}

export async function sendCompare(worktree: string) {
  const c = getCompare(worktree);
  if (!c || c.state !== "done") throw bad("Run it here first");
  if (c.verdict !== "passes-here") throw bad("It fails here too, so send the failure from the run instead");
  await sendToWorker(comparePrompt(c), worktree);
  return { ok: true };
}
