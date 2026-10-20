import { Hono } from "hono";
import { listSessions } from "../claude/sessions.ts";
import { config } from "../config.ts";
import { fixPlan } from "../fix.ts";
import { activeSprint, deploys, epicInfo, myPrs, myTickets, reviewQueue, sprints, worktreeEpics } from "../providers.ts";
import { ticketOf } from "../util.ts";
import { getJob, listJobs } from "../jobs.ts";
import { getReview, listReviews, parsePr, pendingReview, prInfo, reopenReview, startReview } from "../reviews.ts";
import { usageReport } from "../usage.ts";
import { cleanupPlan } from "../cleaner.ts";
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
  .get("/tickets", async (c) => {
    const fresh = c.req.query("fresh") === "1";
    const wtKeys = (await listWorktrees(false)).filter((w) => !w.main && w.ticket).map((w) => w.ticket!);
    const [sprint, tickets, epics] = await Promise.all([activeSprint(), myTickets(fresh), worktreeEpics(wtKeys, fresh)]);
    const last = lastSessions();
    const epicOf = new Map(epics.flatMap((e) => e.children.map((k) => [k, e.key] as const)));
    return c.json({
      sprint,
      tickets: tickets.map((t) => ({ ...t, lastSession: last.get(t.key) ?? null, epic: epicOf.get(t.key) })),
      epics: epics.map((e) => ({ ...e, lastSession: last.get(e.key) ?? null })),
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
    return c.json(createWorktree(key, info.summary));
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
    const { key, summary } = await c.req.json<{ key: string; summary: string }>();
    return c.json(createWorktree(key, summary ?? ""));
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
  .get("/usage", async (c) => c.json(await usageReport(Number(c.req.query("days")) || 30)))
  .get("/reviews", async (c) => c.json(await listReviews()))
  .post("/reviews/check", async (c) => {
    const pr = parsePr((await c.req.json<{ input: string }>()).input);
    if (!pr) return c.json({ error: "paste a pull request link or number" }, 400);
    const [info, pending] = await Promise.all([prInfo(pr), pendingReview(pr)]);
    return c.json({ ...info, repo: pr.repo, number: pr.n, pending: pending ?? null });
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
