// Which PR a run ran against. One worktree can hold a whole stack of PRs, each on its own branch and ticket, so the
// worktree's ticket isn't where a run belongs: the branch checked out when it ran is, through its PR.
import type { PullRequest } from "@cockpit/shared";
import { run } from "./util.ts";

// the branch and commit checked out in a folder; no branch on a detached HEAD
export async function headOf(cwd: string): Promise<{ branch?: string; sha?: string }> {
  // --abbrev-ref applies to what comes after it, so the commit is asked for first
  const out = await run("git", ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 }).catch(() => "");
  const [sha, ref] = out.trim().split("\n");
  return { branch: ref && ref !== "HEAD" ? ref : undefined, sha: sha || undefined };
}

// A branch's PR: the open one, else the newest that was merged, else the newest closed one
export function prFor(branch: string | undefined, prs: PullRequest[]) {
  if (!branch) return undefined;
  const mine = prs.filter((p) => p.branch === branch).sort((a, b) => b.number - a.number);
  return mine.find((p) => p.state === "OPEN") ?? mine.find((p) => p.state === "MERGED") ?? mine[0];
}

// What a run's meta says about its PR
export const prMeta = (pr: PullRequest) => ({ pr: pr.number, prUrl: pr.url, prBranch: pr.branch, ...(pr.base ? { prBase: pr.base } : {}) });

// The branch a worktree had checked out at each moment, from its HEAD reflog (`git log -g --format=%gd%x09%gs
// --date=unix`, newest first): checkouts, and rebases returning to a branch. Returns the moves oldest first.
export function branchMoves(reflog: string) {
  const moves: { at: number; branch: string }[] = [];
  for (const line of reflog.split("\n")) {
    const m = line.match(/^HEAD@\{(\d+)\}\t(.*)$/);
    if (!m) continue;
    const to = m[2].match(/^checkout: moving from .+ to (\S+)$/)?.[1] ?? m[2].match(/returning to refs\/heads\/(\S+)$/)?.[1];
    // a checkout of a commit (40 hex) is a detached HEAD, not a branch
    if (to) moves.push({ at: Number(m[1]) * 1000, branch: /^[0-9a-f]{40}$/.test(to) ? "" : to });
  }
  return moves.reverse();
}

// the branch checked out at a moment, from the moves; undefined before the first one the reflog still has
export function branchAt(moves: { at: number; branch: string }[], at: number) {
  let out: string | undefined;
  for (const m of moves) {
    if (m.at > at) break;
    out = m.branch;
  }
  return out || undefined;
}

export async function reflogOf(dir: string) {
  return run("git", ["log", "-g", "--format=%gd%x09%gs", "--date=unix", "HEAD"], { cwd: dir, timeout: 15_000 }).catch(() => "");
}
