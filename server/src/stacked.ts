// Work stacked on someone else's open PR: a task can start on top of a teammate's branch while their PR is still in
// review. Cockpit remembers which PR it sits on, notices when that PR gets new commits or merges, and on your word
// hands the catching up to the worktree's Claude session (rebasing rewrites a pushed branch, so it never does it alone).
import type { PrRef } from "@cockpit/shared";
import { canSend, sendText } from "./agents.ts";
import { boardChanged, matchWorker } from "./board.ts";
import { listSessions } from "./claude/sessions.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { onEvent } from "./events.ts";
import { notify } from "./notify.ts";
import { parsePr, prInfo } from "./providers.ts";
import { spawnTerm } from "./pty.ts";
import { mainAgent, resumeLaunch } from "./workers/index.ts";
import { startAgent } from "./workers/runner.ts";
import { run } from "./util.ts";
import { listWorktrees } from "./worktrees.ts";

db.exec(`
  create table if not exists stacked (
    worktree text primary key,
    repo text not null,
    pr integer not null,
    url text not null,
    title text,
    author text,
    branch text not null,
    -- the branch their PR merges into, where your work goes once theirs is merged
    target text,
    -- the commit of theirs your work sits on, and the newest one seen on their PR
    base_sha text not null,
    seen_sha text not null,
    -- open: in step, moved: they pushed since, merged / closed: their PR is done, gone: you moved onto the target
    state text not null default 'open',
    note text,
    created_at integer not null
  );
`);

export interface StackRow {
  worktree: string;
  repo: string;
  pr: number;
  url: string;
  title: string | null;
  author: string | null;
  branch: string;
  target: string | null;
  base_sha: string;
  seen_sha: string;
  state: "open" | "moved" | "merged" | "closed" | "gone";
  note: string | null;
  created_at: number;
}

export const stackRows = () => new Map(db.prepare<[], StackRow>("select * from stacked").all().map((r) => [r.worktree, r]));
export const stackOf = (worktree: string) => db.prepare<[string], StackRow>("select * from stacked where worktree = ?").get(worktree);

// The PR a new task should start on, checked before anything is queued
export async function basePr(input: string) {
  const ref = parsePr(input);
  if (!ref) throw Object.assign(new Error("That doesn't look like a pull request link or number"), { status: 400 });
  const info = await prInfo(ref);
  if (info.state && info.state !== "OPEN") throw Object.assign(new Error(`#${ref.n} is ${info.state.toLowerCase()}, so there's nothing to build on. Start from ${config.repo.baseBranch}.`), { status: 400 });
  if (!info.headRefName) throw Object.assign(new Error(`The code host didn't say which branch #${ref.n} is on`), { status: 400 });
  return { ref, info };
}

// Moves a brand new worktree onto the head of their PR. The branch name works for PRs from the same repo; a fork's
// PR is still reachable as pull/<n>/head on GitHub.
export async function stackOnto(worktree: string, input: string) {
  const { ref, info } = await basePr(input);
  const branch = info.headRefName!;
  const git = (...a: string[]) => run("git", ["-C", worktree, ...a]);
  await git("fetch", "origin", branch).catch(() => git("fetch", "origin", `pull/${ref.n}/head`));
  await git("reset", "--hard", "FETCH_HEAD");
  const sha = (await git("rev-parse", "HEAD")).trim();
  db.prepare(
    `insert or replace into stacked (worktree, repo, pr, url, title, author, branch, target, base_sha, seen_sha, state, note, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', null, ?)`,
  ).run(worktree, ref.repo, ref.n, info.url, info.title, info.author, branch, info.baseRefName ?? null, sha, sha, Date.now());
  boardChanged();
  return { ref, info, sha };
}

// what the task's Claude is told up front about the branch it starts on
export const stackedNote = (s: { n: number; title?: string; author?: string; branch: string }) =>
  `\n\nThis branch starts on top of #${s.n}${s.title ? ` (${s.title})` : ""}${s.author ? ` by ${s.author}` : ""}, which is still in review, so its commits are already here. Build on them and don't change them. When you open the PR, target their branch: \`--base ${s.branch}\`.`;

// what the worktree's Claude is asked to do once their PR moved or merged
export function catchUpPrompt(s: Pick<StackRow, "pr" | "branch" | "target" | "base_sha" | "seen_sha" | "state">) {
  if (s.state === "merged") {
    const target = s.target ?? config.repo.baseBranch;
    return `#${s.pr}, the PR this branch was built on, has been merged into ${target}. Move your work onto ${target}: \`git fetch origin ${target}\`, then \`git rebase --onto origin/${target} ${s.seen_sha.slice(0, 12)}\` so only your own commits are replayed (theirs are in ${target} now, possibly squashed). Resolve any conflicts keeping what both sides meant, run the checks, and if this branch was already pushed, push it with \`--force-with-lease\`. If it has a PR, point it at ${target}: \`gh pr edit --base ${target}\`. Tell me what changed. (Sent by cockpit.)`;
  }
  return `#${s.pr} (\`${s.branch}\`), the PR this branch is built on, has new commits. Bring them in: \`git fetch origin ${s.branch}\`, then \`git rebase --onto origin/${s.branch} ${s.base_sha.slice(0, 12)}\`. Resolve any conflicts keeping what both sides meant, run the checks, and if this branch was already pushed, push it with \`--force-with-lease\`. Tell me what changed. (Sent by cockpit.)`;
}

// Their PR, as it is now, against what was last seen
export function nextState(row: Pick<StackRow, "state" | "seen_sha">, pr: { state?: string; headRefOid?: string }): { state: StackRow["state"]; seen: string } | undefined {
  if (row.state === "gone") return;
  if (pr.state === "MERGED" && row.state !== "merged") return { state: "merged", seen: row.seen_sha };
  if (pr.state === "CLOSED" && row.state !== "closed") return { state: "closed", seen: row.seen_sha };
  if (pr.state === "OPEN" && pr.headRefOid && pr.headRefOid !== row.seen_sha) return { state: "moved", seen: pr.headRefOid };
}

let running = false;
async function tick() {
  if (running) return;
  const rows = db.prepare<[], StackRow>("select * from stacked where state in ('open', 'moved')").all();
  if (!rows.length) return;
  running = true;
  try {
    for (const r of rows) {
      const info = await prInfo({ repo: r.repo, n: r.pr } as PrRef).catch(() => undefined);
      if (!info) continue;
      const next = nextState(r, info);
      if (!next) continue;
      const note = next.state === "merged" ? `#${r.pr} merged into ${r.target ?? "its base"}` : next.state === "closed" ? `#${r.pr} was closed without merging` : `#${r.pr} has new commits`;
      db.prepare("update stacked set state = ?, seen_sha = ?, note = ? where worktree = ?").run(next.state, next.seen, note, r.worktree);
      // a second push while it's already marked moved isn't news
      if (r.state !== next.state) notify({ title: note, body: `${r.title ?? r.branch}: your work is built on it. Catch up from the Board.`, link: `/board?card=${encodeURIComponent(r.worktree)}`, kind: "task" });
      boardChanged();
    }
  } finally {
    running = false;
  }
}

// Hands the catching up to the worktree's Claude: the live session when it's free, else its last one resumed
export async function catchUp(worktree: string) {
  const r = stackOf(worktree);
  if (!r) throw Object.assign(new Error("This worktree isn't built on another PR"), { status: 400 });
  if (r.state !== "moved" && r.state !== "merged") throw Object.assign(new Error(r.state === "closed" ? `#${r.pr} was closed, so there's nothing to catch up with` : `#${r.pr} hasn't changed since`), { status: 400 });
  const wt = (await listWorktrees(false)).find((w) => w.path === worktree);
  if (!wt) throw Object.assign(new Error("The worktree is gone"), { status: 400 });
  const { session } = matchWorker(wt, [], listSessions({ limit: 800 }));
  if (session?.status === "busy") throw Object.assign(new Error("Claude is busy in this worktree. Try again once it finishes its turn."), { status: 409 });
  const prompt = catchUpPrompt(r);
  let how: string;
  // only an idle session is told; one waiting on a question would take it as the answer
  if (session && (session.agent || session.status === "idle") && canSend(session.id) && (await sendText(session.id, prompt))) how = "Told its session";
  else {
    // with no session to go on, a main agent other than Claude Code starts one of its own, run a turn at a time
    const main = !session ? mainAgent() : undefined;
    if (main) startAgent({ agent: main.id, cwd: worktree, prompt, title: `catch up #${r.pr}` });
    else spawnTerm({ cwd: worktree, ...(session ? resumeLaunch(session.id, prompt) : { command: "claude", args: [prompt] }), title: `catch up #${r.pr}`, session: session?.id });
    how = session ? "Resumed its session" : `Started ${main?.name ?? "Claude"}`;
  }
  // after a merge the work lives on the target, so there's nothing left to follow
  if (r.state === "merged") db.prepare("update stacked set state = 'gone', note = ? where worktree = ?").run(`${how} to move onto ${r.target ?? "the base"}`, worktree);
  else db.prepare("update stacked set state = 'open', base_sha = seen_sha, note = ? where worktree = ?").run(`${how} to bring in #${r.pr}'s new commits`, worktree);
  boardChanged();
  return { ok: true, how };
}

export function startStacked() {
  setInterval(() => tick().catch((e) => console.error("stacked", e)), 180_000);
  onEvent((event, data) => {
    if (event === "worktree.removed") db.prepare("delete from stacked where worktree = ?").run((data as { path: string }).path);
  });
}
