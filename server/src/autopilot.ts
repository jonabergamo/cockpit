// Autopilot: when a PR you turned it on for goes red (failing checks, changes requested), the failure goes
// back to the Claude session that owns the work, without you pressing anything. It gives up after a few tries.
import type { PullRequest } from "@cockpit/shared";
import { paneOf, sendText } from "./agents.ts";
import { boardChanged, matchWorker } from "./board.ts";
import { listSessions } from "./claude/sessions.ts";
import { db } from "./db.ts";
import { emit, onEvent } from "./events.ts";
import { fixPrompt } from "./fix.ts";
import { notify } from "./notify.ts";
import { myPrs, reviewThreads } from "./providers.ts";
import { spawnTerm } from "./pty.ts";
import { getSettings } from "./settings.ts";
import { listWorktrees } from "./worktrees.ts";

interface Row {
  worktree: string;
  enabled: number;
  attempts: number;
  signature: string | null;
  gave_up: number;
  note: string | null;
}

export function setAutopilot(worktree: string, on: boolean) {
  db.prepare(
    `insert into autopilot (worktree, enabled, attempts, gave_up) values (?, ?, 0, 0)
     on conflict(worktree) do update set enabled = excluded.enabled, attempts = case when excluded.enabled = 1 then 0 else attempts end, gave_up = 0, note = null`,
  ).run(worktree, on ? 1 : 0);
  boardChanged();
  if (on) setTimeout(() => tick().catch((e) => console.error("autopilot", e)), 1000);
}

// What the PR looks like now; autopilot only acts when this changes, so it never repeats itself on the same failure
export const signatureOf = (pr: Pick<PullRequest, "headSha" | "checks" | "reviewDecision">, threads: number) => `${pr.headSha ?? ""}|${pr.checks ?? ""}|${pr.reviewDecision ?? ""}|${threads}`;

export function decide(pr: Pick<PullRequest, "state" | "checks" | "reviewDecision">, row: Pick<Row, "attempts" | "signature">, signature: string, max: number) {
  if (pr.state !== "OPEN") return { act: "none" as const };
  const kind = pr.checks === "fail" ? ("checks" as const) : pr.reviewDecision === "CHANGES_REQUESTED" ? ("comments" as const) : undefined;
  if (!kind) return { act: row.attempts > 0 && pr.checks === "pass" && row.signature !== signature ? ("green" as const) : ("none" as const) };
  if (row.signature === signature) return { act: "none" as const };
  if (row.attempts >= max) return { act: "give-up" as const, kind };
  return { act: "fix" as const, kind };
}

let running = false;
async function tick() {
  if (running) return;
  const rows = db.prepare<[], Row>("select * from autopilot where enabled = 1 and gave_up = 0").all();
  if (!rows.length) return;
  running = true;
  try {
    const [prs, worktrees] = await Promise.all([myPrs(true), listWorktrees(false)]);
    const sessions = listSessions({ limit: 800 });
    const max = getSettings().autopilot.maxAttempts;
    for (const r of rows) {
      const wt = worktrees.find((w) => w.path === r.worktree);
      if (!wt) continue;
      const { pr, session } = matchWorker(wt, prs, sessions);
      if (!pr) continue;
      const threads = pr.reviewDecision === "CHANGES_REQUESTED" ? (await reviewThreads(pr.number).catch(() => [])).length : 0;
      const sig = signatureOf(pr, threads);
      const d = decide(pr, r, sig, max);
      const save = (patch: Partial<Row> & { last_at?: number }) => {
        const keys = Object.keys(patch);
        db.prepare(`update autopilot set ${keys.map((k) => `${k} = ?`).join(", ")} where worktree = ?`).run(...keys.map((k) => (patch as Record<string, unknown>)[k] ?? null), r.worktree);
      };
      if (d.act === "green") {
        save({ signature: sig, note: "Checks are green again" });
        notify({ title: `#${pr.number} is green again`, body: pr.title, link: pr.url, kind: "autopilot" });
        boardChanged();
        continue;
      }
      if (d.act === "give-up") {
        save({ gave_up: 1, signature: sig, note: `Stopped after ${r.attempts} tries` });
        notify({ title: `Autopilot gave up on #${pr.number}`, body: `${pr.title}: still ${d.kind === "checks" ? "failing" : "has changes requested"} after ${r.attempts} tries.`, link: `/board?card=${encodeURIComponent(r.worktree)}`, kind: "autopilot" });
        boardChanged();
        continue;
      }
      if (d.act !== "fix") continue;
      // never talk over Claude; next tick it'll be done
      if (session?.status === "busy") continue;
      const prompt = `${await fixPrompt(pr, d.kind)}\n\n(Sent by cockpit's autopilot, try ${r.attempts + 1} of ${max}.)`;
      let how: string;
      if (session && session.status === "idle" && paneOf(session.id) && (await sendText(session.id, prompt))) how = "told its session";
      else {
        // its last session keeps the context; otherwise a new one in the worktree
        const args = session ? ["--resume", session.id, prompt] : [prompt];
        spawnTerm({ cwd: wt.path, command: "claude", args, title: `autopilot #${pr.number}`, session: session?.id });
        how = session ? "resumed its session" : "started Claude";
      }
      save({ attempts: r.attempts + 1, signature: sig, last_at: Date.now(), note: `${d.kind === "checks" ? "Fixing the checks" : "Answering the review"}: ${how}` });
      notify({ title: `Autopilot is on #${pr.number}`, body: `${d.kind === "checks" ? "Checks failed" : "Changes requested"}, so it ${how}.`, link: `/board?card=${encodeURIComponent(r.worktree)}`, kind: "autopilot" });
      emit("autopilot.acted", { worktree: r.worktree, pr: pr.number, kind: d.kind, attempt: r.attempts + 1 });
      boardChanged();
    }
  } finally {
    running = false;
  }
}

export function startAutopilot() {
  setInterval(() => tick().catch((e) => console.error("autopilot", e)), 120_000);
  onEvent((event, data) => {
    if (event === "worktree.created" && getSettings().autopilot.onByDefault) setAutopilot((data as { path: string }).path, true);
  });
}
