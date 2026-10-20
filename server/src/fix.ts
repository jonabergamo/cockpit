import { existsSync } from "node:fs";
import { listSessions } from "./claude/sessions.ts";
import { failingChecks, myPrs } from "./providers.ts";
import { listWorktrees } from "./worktrees.ts";

// What to send and where: the newest session that worked in the PR's worktree (or on its ticket), else a new
// one in that worktree.
export async function fixPlan(n: number, kind: "checks" | "comments") {
  const pr = (await myPrs()).find((p) => p.number === n);
  if (!pr) throw new Error(`#${n} isn't one of your PRs`);
  const wt = (await listWorktrees(false)).find((w) => !w.main && (w.branch === pr.branch || (!!pr.ticket && w.ticket === pr.ticket)));
  const inside = (cwd?: string) => !!wt && !!cwd && (cwd === wt.path || cwd.startsWith(wt.path + "/"));
  const session = listSessions({ limit: 2000 })
    .filter((s) => inside(s.cwd) || (!!pr.ticket && s.ticket === pr.ticket))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  let prompt: string;
  if (kind === "checks") {
    const failing = await failingChecks(n);
    prompt = [
      `The checks on ${pr.url} are failing. Find out why and fix it, then push.`,
      ...failing.map((c) => `\nFailing: ${c.name} (${c.link})${c.tail ? `\nEnd of its log:\n${c.tail}` : ""}`),
    ].join("\n");
  } else {
    prompt = `${pr.url} has review comments to address. Read the unresolved review threads with gh, make the changes that are right, reply where you disagree, then push.`;
  }
  return { prompt, sessionId: session?.id ?? null, cwd: wt && existsSync(wt.path) ? wt.path : null };
}
