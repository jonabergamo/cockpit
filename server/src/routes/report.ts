import { Hono } from "hono";
import { listSessions } from "../claude/sessions.ts";
import { tracker } from "../providers.ts";
import { DEFAULT_NOTES_PROMPT, generateNotes, savedNotes, sprintBrief } from "../notes.ts";
import { activity, dailyText, sayDo, sprintReport, takeSnapshot, weekly } from "../report.ts";
import { day } from "../util.ts";

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
  // sessions that overlap a given day, for the "my day" timeline
  .get("/day", async (c) => {
    const date = c.req.query("date") ?? day(new Date());
    const start = new Date(`${date}T00:00:00`).getTime();
    const end = start + 864e5;
    const sessions = listSessions({ limit: 5000 }).filter((s) => s.startedAt < end && s.updatedAt >= start);
    const [act] = await activity(date, date);
    return c.json({ ...act, date, sessions, costBySession: act.sessions });
  });
