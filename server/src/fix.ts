import { existsSync } from "node:fs";
import type { PullRequest } from "@cockpit/shared";
import { matchWorker } from "./board.ts";
import { flakyNote, flakyOf } from "./flaky.ts";
import { listSessions } from "./claude/sessions.ts";
import { failingChecks, myPrs, reviewThreads } from "./providers.ts";
import { allWorktrees } from "./remote/work.ts";

// What Claude gets told about a red PR: the failing checks with the end of their logs, or the review threads.
export async function fixPrompt(pr: PullRequest, kind: "checks" | "comments") {
  if (kind === "checks") {
    const failing = await failingChecks(pr.number);
    return [
      `The checks on ${pr.url} are failing. Find out why and fix it, then push.`,
      ...failing.map((c) => {
        const flaky = flakyOf("ci", c.name);
        return `\nFailing${flaky ? " (known flaky)" : ""}: ${c.name} (${c.link})${flaky ? `\n${flakyNote(flaky)} Check whether this failure is that before changing code for it.` : ""}${c.tail ? `\nEnd of its log:\n${c.tail}` : ""}`;
      }),
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
  // a worktree on a node counts: starting Claude in it opens on that node
  const wt = (await allWorktrees(false)).find((w) => !w.main && (w.branch === pr.branch || (!!pr.ticket && w.ticket === pr.ticket)));
  const sessions = listSessions({ limit: 2000 });
  const session = (wt && matchWorker(wt, [pr], sessions).session) ?? sessions.filter((s) => !!pr.ticket && s.ticket === pr.ticket).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return { prompt: await fixPrompt(pr, kind), sessionId: session?.id ?? null, cwd: wt && (wt.node || existsSync(wt.path)) ? wt.path : null };
}
