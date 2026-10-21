import { existsSync } from "node:fs";
import type { PullRequest } from "@cockpit/shared";
import { matchWorker } from "./board.ts";
import { listSessions } from "./claude/sessions.ts";
import { failingChecks, myPrs, reviewThreads } from "./providers.ts";
import { listWorktrees } from "./worktrees.ts";

// What Claude gets told about a red PR: the failing checks with the end of their logs, or the review threads.
export async function fixPrompt(pr: PullRequest, kind: "checks" | "comments") {
  if (kind === "checks") {
    const failing = await failingChecks(pr.number);
    return [
      `The checks on ${pr.url} are failing. Find out why and fix it, then push.`,
      ...failing.map((c) => `\nFailing: ${c.name} (${c.link})${c.tail ? `\nEnd of its log:\n${c.tail}` : ""}`),
    ].join("\n");
  }
  const threads = await reviewThreads(pr.number).catch(() => []);
  const quoted = threads.map((t) => `- ${t.path ? `${t.path}${t.line ? `:${t.line}` : ""} ` : ""}${t.author ? `(${t.author}) ` : ""}${t.body.replace(/\s+/g, " ").slice(0, 600)}`);
  return [
    `${pr.url} has review comments to address. Make the changes that are right, reply on the thread where you disagree, then push.`,
    quoted.length ? `\nUnresolved comments:\n${quoted.join("\n")}` : "Read the unresolved review threads with gh first.",
  ].join("\n");
}

// What to send and where: the newest session that worked in the PR's worktree (or on its ticket), else a new
// one in that worktree.
export async function fixPlan(n: number, kind: "checks" | "comments") {
  const pr = (await myPrs()).find((p) => p.number === n);
  if (!pr) throw new Error(`#${n} isn't one of your PRs`);
  const wt = (await listWorktrees(false)).find((w) => !w.main && (w.branch === pr.branch || (!!pr.ticket && w.ticket === pr.ticket)));
  const sessions = listSessions({ limit: 2000 });
  const session = (wt && matchWorker(wt, [pr], sessions).session) ?? sessions.filter((s) => !!pr.ticket && s.ticket === pr.ticket).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return { prompt: await fixPrompt(pr, kind), sessionId: session?.id ?? null, cwd: wt && existsSync(wt.path) ? wt.path : null };
}
