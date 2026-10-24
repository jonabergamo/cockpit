import { existsSync } from "node:fs";
import type { Worktree } from "@cockpit/shared";
import { basename } from "node:path";
import { listSessions } from "./claude/sessions.ts";
import { devDoneSet, myPrs, releasedSet, statusesOf, worktreeEpics } from "./providers.ts";
import { listTerms } from "./pty.ts";
import { run } from "./util.ts";
import { leftoverFolders, listWorktrees, sizeOf } from "./worktrees.ts";

const STALE_DAYS = 30;
// QA and UAT count as done for the sprint but can still bounce back, so only released or closed tickets
// (the tracker's done category minus the dev-done statuses) mean the work is over
const finished = (t: { status: string; statusCategory?: string }) => releasedSet().has(t.status) || (t.statusCategory === "done" && !devDoneSet().has(t.status));

export interface Candidate {
  path: string;
  name: string;
  branch?: string;
  ticket?: string;
  ticketStatus?: string;
  pr?: { number: number; state: string; url: string };
  sizeBytes?: number;
  lastCommitAt?: number;
  // why it could go, and what should make you look first
  reasons: string[];
  blockers: string[];
  verdict: "safe" | "check" | "keep";
  leftover?: boolean;
  // the machine it's on, when that's a node
  node?: string;
}

const within = (cwd: string | undefined, path: string) => !!cwd && (cwd === path || cwd.startsWith(path + "/"));

// Works out, for every worktree, whether it's done with. Jira and GitHub answers come from the shared cache,
// so this only reaches out when asked to refresh.
export async function cleanupPlan(force = false): Promise<Candidate[]> {
  const wts = (await listWorktrees(true)).filter((w) => !w.main);
  const keys = wts.flatMap((w) => (w.ticket ? [w.ticket] : []));
  const [prs, statuses, epics] = await Promise.all([myPrs(force).catch(() => []), statusesOf(keys, force).catch(() => []), worktreeEpics(keys, force).catch(() => [])]);
  const statusBy = new Map(statuses.map((t) => [t.key, t]));
  const live = listSessions({ liveOnly: true });
  const terms = listTerms().filter((t) => t.exited === undefined);

  // a detached checkout's commits live only in that folder unless some branch contains them
  const orphaned = new Set(
    (
      await Promise.all(
        wts
          .filter((w) => !w.branch && existsSync(w.path))
          .map(async (w) => ((await run("git", ["-C", w.path, "branch", "-a", "--contains", "HEAD"]).catch(() => "x")).trim() ? "" : w.path)),
      )
    ).filter(Boolean),
  );

  const leftovers: Candidate[] = await Promise.all(
    (await leftoverFolders()).map(async (path) => ({
      path,
      name: basename(path),
      sizeBytes: await sizeOf(path).catch(() => undefined),
      reasons: ["git no longer tracks it"],
      blockers: [],
      verdict: "safe" as const,
      leftover: true,
    })),
  );

  return [
    ...leftovers,
    ...wts.map((w) =>
      judge(w, {
        pr: prs.find((p) => p.branch === w.branch) ?? prs.find((p) => !!w.ticket && p.ticket === w.ticket),
        ticket: w.ticket ? statusBy.get(w.ticket) : undefined,
        missing: !existsSync(w.path),
        orphaned: orphaned.has(w.path),
        busy: live.some((s) => within(s.cwd, w.path)),
        termOpen: terms.some((x) => within(x.cwd, w.path)),
        epic: epics.some((e) => e.key === w.ticket),
      }),
    ),
  ];
}

interface Facts {
  pr?: { number: number; state: string; url: string };
  ticket?: { key: string; status: string; statusCategory?: string };
  missing: boolean;
  orphaned: boolean;
  busy: boolean;
  termOpen: boolean;
  epic: boolean;
}

// The rules on their own, so they can be tested without git, Jira or GitHub.
export function judge(w: Worktree, f: Facts, now = Date.now()): Candidate {
  const { pr, ticket: t } = f;
  const reasons: string[] = [];
  const blockers: string[] = [];

  if (f.missing) reasons.push("folder is already gone");
  if (pr?.state === "MERGED") reasons.push(`PR #${pr.number} merged`);
  if (pr?.state === "CLOSED") reasons.push(`PR #${pr.number} closed`);
  if (t && finished(t)) reasons.push(`${t.key} is ${t.status}`);
  const idle = w.lastCommitAt ? (now - w.lastCommitAt) / 864e5 : undefined;
  if (idle !== undefined && idle > STALE_DAYS && pr?.state !== "OPEN") reasons.push(`no commits for ${Math.floor(idle)} days`);

  if (!f.missing) {
    if (w.dirty) blockers.push(`${w.dirty} uncommitted ${w.dirty === 1 ? "file" : "files"}`);
    if (f.orphaned) blockers.push("detached, its commit is on no branch");
    if (w.ahead) blockers.push(`${w.ahead} ${w.ahead === 1 ? "commit" : "commits"} not pushed`);
    if (pr?.state === "OPEN") blockers.push(`PR #${pr.number} still open`);
    if (f.busy) blockers.push("Claude is running in it");
    if (f.termOpen) blockers.push("a terminal is open in it");
    if (f.epic && !(t && finished(t))) blockers.push("epic still in progress");
  }

  return {
    path: w.path,
    name: w.name,
    branch: w.branch,
    ticket: w.ticket,
    ticketStatus: t?.status,
    pr: pr && { number: pr.number, state: pr.state, url: pr.url },
    sizeBytes: w.sizeBytes,
    lastCommitAt: w.lastCommitAt,
    reasons,
    blockers,
    verdict: !reasons.length ? "keep" : blockers.length ? "check" : "safe",
  };
}
