import { Hono } from "hono";
import { listSessions } from "../claude/sessions.ts";
import { tracker } from "../providers.ts";
import { DEFAULT_NOTES_PROMPT, generateNotes, savedNotes, sprintBrief } from "../notes.ts";
import { activity, dailyText, sayDo, sprintReport, takeSnapshot, weekly } from "../report.ts";
import { waitsEverywhere } from "../remote/sessions.ts";
import { day } from "../util.ts";
import { waitTotals } from "../waits.ts";

// a day runs until this hour the next morning, so a late night stays on the day it began
const ROLLOVER_H = 5;

export const report = new Hono()
  .get("/sprint", async (c) => {
    const id = c.req.query("id");
    const r = await sprintReport(id ? Number(id) : undefined, c.req.query("scope") === "me" ? "me" : "team");
    if (r) return c.json(r);
    // say why, since a new setup lands here before its tracker is set up
    const why = !tracker()?.sprints ? "No tracker with sprints is on. Turn on Jira, or another tracker, in Settings → Plugins." : id ? "That sprint isn't on the board." : "The board has no active sprint.";
    return c.json({ error: why }, 404);
  })
  .post("/snapshot", async (c) => {
    await takeSnapshot();
    return c.json({ ok: true });
  })
  .get("/activity", async (c) => {
    const to = c.req.query("to") ?? day(new Date());
    const from = c.req.query("from") ?? day(Date.now() - 13 * 864e5);
    return c.json(await activity(from, to));
  })
  .get("/saydo", async (c) => c.json(await sayDo(Number(c.req.query("count")) || 6, c.req.query("scope") === "me" ? "me" : "team")))
  .get("/daily", async (c) => c.text(await dailyText()))
  .get("/weekly", async (c) => c.json(await weekly()))
  // additional notes: the last ones written for a sprint, the data they're written from, and a new run
  .get("/notes", (c) => c.json({ ...savedNotes(Number(c.req.query("id"))), defaultPrompt: DEFAULT_NOTES_PROMPT }))
  .get("/notes/brief", async (c) => {
    const id = Number(c.req.query("id")) || undefined;
    try {
      return c.text((await sprintBrief(id)).text);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  })
  .post("/notes", async (c) => {
    const { id } = await c.req.json<{ id?: number }>().catch(() => ({ id: undefined }));
    try {
      return c.json(await generateNotes(id || undefined));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  })
  // sessions that overlap a given day, for the "my day" timeline, and how long they waited on you in it
  .get("/day", async (c) => {
    const date = c.req.query("date") ?? day(Date.now() - ROLLOVER_H * 3600_000);
    const start = new Date(`${date}T00:00:00`);
    start.setHours(ROLLOVER_H);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const [from, to] = [start.getTime(), end.getTime()];
    const all = listSessions({ limit: 5000 });
    const sessions = all.filter((s) => s.startedAt < to && s.updatedAt >= from);
    const [[next, act], found] = await Promise.all([activity(date, day(end)), waitsEverywhere(from, to)]);
    // the commits of the small hours belong to the night before
    const commits = [...act.commits, ...next.commits].filter((x) => Date.parse(x.at) >= from && Date.parse(x.at) < to).sort((a, b) => a.at.localeCompare(b.at));
    const byId = new Map(all.map((s) => [s.id, s]));
    const waits = found.map((w) => ({ ...w, title: byId.get(w.session)?.title ?? byId.get(w.session)?.name, ticket: byId.get(w.session)?.ticket }));
    const { ms, longest } = waitTotals(waits, from, to);
    return c.json({ ...act, commits, date, from, to, sessions, costBySession: act.sessions, waits, waited: { ms, longest } });
  });
