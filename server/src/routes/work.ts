import { Hono } from "hono";
import { listSessions } from "../claude/sessions.ts";
import { config } from "../config.ts";
import { db } from "../db.ts";
import { fixPlan } from "../fix.ts";
import { activeSprint, deploys, epicInfo, myPrs, myTickets, requestReview, reviewQueue, sprints, worktreeEpics } from "../providers.ts";
import { ticketOf } from "../util.ts";
import { getJob, listJobs } from "../jobs.ts";
import { getReview, lastReview, listReviews, parsePr, pendingReview, prInfo, reopenReview, startReview } from "../reviews.ts";
import { toolReport, usageReport } from "../usage.ts";
import { cleanupPlan } from "../cleaner.ts";
import { archive, board, boardChanged } from "../board.ts";
import { badges, seen } from "../badges.ts";
import { setAutopilot } from "../autopilot.ts";
import { catchUp } from "../stacked.ts";
import { getCompare, sendCompare, startCompare } from "../cicompare.ts";
import { budgets, setBudget, ticketSpend } from "../budget.ts";
import { templateFor } from "../templates.ts";
import { weekly, weekStart } from "../weekly.ts";
import { runVerify, sendFailure } from "../verify.ts";
import { previewOf, startPreview, stopPreview } from "../preview.ts";
import { createWorktree, deleteWorktree, deleteWorktrees, leftoverFolders, link, listWorktrees, openInEditor, refreshSizes, unlink } from "../worktrees.ts";

// the newest Claude session per ticket comes from the local index, no extra calls
function lastSessions() {
  const last = new Map<string, { id: string; status: string; updatedAt: number }>();
  for (const s of listSessions({ limit: 2000 })) {
    if (!s.ticket) continue;
    const seen = last.get(s.ticket);
    if (!seen || s.updatedAt > seen.updatedAt) last.set(s.ticket, { id: s.id, status: s.status, updatedAt: s.updatedAt });
  }
  return last;
}

export const work = new Hono()
  .get("/board", async (c) => c.json(await board()))
  .get("/badges", async (c) => c.json(await badges()))
  // the screen was opened: its "since you last looked" count starts again
  .post("/badges/seen", async (c) => {
    const { id } = await c.req.json<{ id: string }>();
    if (typeof id !== "string" || !/^(\/[\w/-]*|plugin:[\w-]+\/[\w-]+)$/.test(id)) return c.json({ error: "a sidebar entry's id" }, 400);
    return c.json(await seen(id));
  })
  // the work built on a teammate's PR catches up with it, through the worktree's Claude
  .post("/stacked/catch-up", async (c) => c.json(await catchUp((await c.req.json<{ worktree: string }>()).worktree)))
  // a failing CI check run here, side by side with CI's result
  .get("/ci/compare", (c) => c.json(getCompare(c.req.query("worktree") ?? "")))
  .post("/ci/compare", async (c) => {
    const { worktree, check } = await c.req.json<{ worktree: string; check?: string }>();
    return c.json(await startCompare(worktree, check));
  })
  .post("/ci/compare/send", async (c) => c.json(await sendCompare((await c.req.json<{ worktree: string }>()).worktree)))
  .post("/autopilot", async (c) => {
    const { worktree, on } = await c.req.json<{ worktree: string; on: boolean }>();
    if (!(await listWorktrees(false)).some((w) => w.path === worktree && !w.main)) return c.json({ error: "not a worktree" }, 400);
    setAutopilot(worktree, on);
    return c.json({ ok: true });
  })
  // ask these code host logins to review one of your PRs again
  .post("/prs/:n/rerequest", async (c) => {
    const n = Number(c.req.param("n"));
    const { logins } = await c.req.json<{ logins: string[] }>();
    if (!Number.isInteger(n) || !Array.isArray(logins) || !logins.length || !logins.every((l) => /^[\w.-]+(\/[\w.-]+)?$/.test(l))) return c.json({ error: "a PR number and reviewer logins" }, 400);
    try {
      await requestReview(n, logins);
      await myPrs(true);
      boardChanged();
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 500) as 400);
    }
  })
  // the week holding this date, this week by default
  .get("/weekly", async (c) => {
    const at = c.req.query("week");
    const d = at && /^\d{4}-\d{2}-\d{2}$/.test(at) ? new Date(`${at}T12:00:00`) : new Date();
    return c.json(await weekly(weekStart(d)));
  })
  .get("/budgets", (c) => c.json(budgets()))
  // in the unit that's showing, dollars or tokens; null goes back to the default budget, 0 is none for this ticket
  .put("/budgets/:ticket", async (c) => {
    const ticket = c.req.param("ticket");
    const { amount } = await c.req.json<{ amount: number | null }>();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(ticket)) return c.json({ error: "not a ticket key" }, 400);
    if (amount !== null && !(typeof amount === "number" && Number.isFinite(amount) && amount >= 0)) return c.json({ error: "amount must be a number, or null for the default" }, 400);
    setBudget(ticket, amount);
    return c.json(budgets());
  })
  .post("/verify", async (c) => {
    const { worktree } = await c.req.json<{ worktree: string }>();
    if (!(await listWorktrees(false)).some((w) => w.path === worktree)) return c.json({ error: "not a worktree" }, 400);
    try {
      const job = await runVerify(worktree, true);
      return c.json({ jobId: job?.id ?? null });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  })
  .post("/verify/send", async (c) => {
    try {
      await sendFailure((await c.req.json<{ worktree: string }>()).worktree);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  })
  .get("/preview", (c) => c.json(previewOf(c.req.query("worktree") ?? "")))
  .post("/preview", async (c) => {
    const { worktree, stop } = await c.req.json<{ worktree: string; stop?: boolean }>();
    if (!(await listWorktrees(false)).some((w) => w.path === worktree)) return c.json({ error: "not a worktree" }, 400);
    try {
      if (stop) return c.json((stopPreview(worktree), { ok: true }));
      return c.json(await startPreview(worktree));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  })
  // what happened since a time, for "while you were away"
  .get("/digest", (c) => {
    const since = Number(c.req.query("since")) || Date.now() - 3600_000;
    return c.json(db.prepare("select at, kind, title, body, link from events_log where at > ? order by at desc limit 80").all(since));
  })
  .post("/board/archive", async (c) => {
    const { id, on } = await c.req.json<{ id: string; on?: boolean }>();
    archive(id, on !== false);
    return c.json({ ok: true });
  })
  .get("/tickets", async (c) => {
    const fresh = c.req.query("fresh") === "1";
    const wtKeys = (await listWorktrees(false)).filter((w) => !w.main && w.ticket).map((w) => w.ticket!);
    const [sprint, tickets, epics] = await Promise.all([activeSprint(), myTickets(fresh), worktreeEpics(wtKeys, fresh)]);
    const last = lastSessions();
    const costs = ticketSpend();
    const spend = (key: string) => {
      const t = costs.get(key);
      return t && { spent: t.spent, limit: t.limit, unit: t.unit, warnPct: t.warnPct };
    };
    const epicOf = new Map(epics.flatMap((e) => e.children.map((k) => [k, e.key] as const)));
    return c.json({
      sprint,
      tickets: tickets.map((t) => ({ ...t, lastSession: last.get(t.key) ?? null, epic: epicOf.get(t.key), spend: spend(t.key), kind: templateFor(t)?.name })),
      epics: epics.map((e) => ({ ...e, lastSession: last.get(e.key) ?? null, spend: spend(e.key) })),
    });
  })
  // Sets up the one worktree an epic's stacked tickets are worked in
  .post("/epics", async (c) => {
    const key = ticketOf((await c.req.json<{ input: string }>()).input);
    if (!key) return c.json({ error: `paste an epic key or link (${config.repo.keyPattern})` }, 400);
    const info = await epicInfo(key);
    if (!info.isEpic) return c.json({ error: `${key} isn't an epic` }, 400);
    // already has a worktree: just make sure it's tied to the epic
    const existing = (await listWorktrees(false)).find((w) => !w.main && (w.ticket === key || w.path.includes(`/${key}/`)));
    if (existing) {
      link(key, existing.path);
      return c.json({ existing: existing.path });
    }
    try {
      return c.json(createWorktree(key, info.summary, { template: templateFor({ summary: info.summary, type: "Epic" }) }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  })
  .get("/sprints", async (c) => c.json(await sprints()))
  .get("/prs", async (c) => {
    const fresh = c.req.query("fresh") === "1";
    const [mine, review] = await Promise.all([myPrs(fresh), reviewQueue(fresh)]);
    return c.json({ mine, review });
  })
  .get("/prs/:n/fix", async (c) => c.json(await fixPlan(Number(c.req.param("n")), c.req.query("kind") === "comments" ? "comments" : "checks")))
  .get("/deploys", async (c) => c.json(await deploys(c.req.query("since") ?? new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10))))
  .get("/worktrees", async (c) => {
    refreshSizes();
    return c.json(await listWorktrees());
  })
  .post("/worktrees", async (c) => {
    const { key, summary, type, template } = await c.req.json<{ key: string; summary: string; type?: string; template?: string }>();
    try {
      return c.json(createWorktree(key, summary ?? "", { template: templateFor({ summary, type }, template) }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  })
  .post("/worktrees/open", async (c) => c.json(openInEditor((await c.req.json<{ path: string }>()).path)))
  .get("/worktrees/clean", async (c) => c.json(await cleanupPlan(c.req.query("fresh") === "1")))
  .post("/worktrees/clean", async (c) => {
    const { paths } = await c.req.json<{ paths: string[] }>();
    const known = new Set((await listWorktrees(false)).filter((w) => !w.main).map((w) => w.path));
    const stray = new Set(await leftoverFolders());
    const ok = (paths ?? []).filter((p) => known.has(p));
    const left = (paths ?? []).filter((p) => stray.has(p));
    if (!ok.length && !left.length) return c.json({ error: "none of those are removable worktrees" }, 400);
    return c.json(deleteWorktrees(ok, left));
  })
  .post("/worktrees/delete", async (c) => {
    const { path } = await c.req.json<{ path: string }>();
    const wt = (await listWorktrees(false)).find((w) => w.path === path);
    if (!wt || wt.main) return c.json({ error: "not a removable worktree" }, 400);
    return c.json(deleteWorktree(path));
  })
  .post("/links", async (c) => {
    const { ticket, worktree, remove } = await c.req.json<{ ticket: string; worktree: string; remove?: boolean }>();
    (remove ? unlink : link)(ticket, worktree);
    return c.json({ ok: true });
  })
  .get("/usage/tools", (c) => c.json(toolReport(Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 365))))
  .get("/usage", async (c) => c.json(await usageReport(Number(c.req.query("days")) || 30)))
  .get("/reviews", async (c) => c.json(await listReviews()))
  .post("/reviews/check", async (c) => {
    const pr = parsePr((await c.req.json<{ input: string }>()).input);
    if (!pr) return c.json({ error: "paste a pull request link or number" }, 400);
    const [info, pending] = await Promise.all([prInfo(pr), pendingReview(pr)]);
    return c.json({ ...info, repo: pr.repo, number: pr.n, pending: pending ?? null });
  })
  // your last review of a PR and what changed since, null when there's none
  .get("/reviews/last", async (c) => {
    const pr = parsePr(c.req.query("pr") ?? "");
    if (!pr) return c.json({ error: "a pull request link or number" }, 400);
    return c.json((await lastReview(pr)) ?? null);
  })
  .post("/reviews", async (c) => c.json(await startReview(await c.req.json())))
  .post("/reviews/:id/reopen", async (c) => c.json(await reopenReview(Number(c.req.param("id")))))
  .get("/reviews/:id", async (c) => {
    const r = await getReview(Number(c.req.param("id")));
    return r ? c.json(r) : c.notFound();
  })
  .get("/jobs", (c) => c.json(listJobs()))
  .get("/jobs/:id", (c) => {
    const job = getJob(c.req.param("id"));
    return job ? c.json(job) : c.notFound();
  });
