import { Hono } from "hono";
import { listSessions } from "../claude/sessions.ts";
import { activity, dailyText, sayDo, sprintReport, takeSnapshot, weekly } from "../report.ts";
import { day } from "../util.ts";

export const report = new Hono()
  .get("/sprint", async (c) => {
    const id = c.req.query("id");
    const r = await sprintReport(id ? Number(id) : undefined, c.req.query("scope") === "me" ? "me" : "team");
    return r ? c.json(r) : c.json({ error: "no sprint" }, 404);
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
  // sessions that overlap a given day, for the "my day" timeline
  .get("/day", async (c) => {
    const date = c.req.query("date") ?? day(new Date());
    const start = new Date(`${date}T00:00:00`).getTime();
    const end = start + 864e5;
    const sessions = listSessions({ limit: 5000 }).filter((s) => s.startedAt < end && s.updatedAt >= start);
    const [act] = await activity(date, date);
    return c.json({ ...act, date, sessions, costBySession: act.sessions });
  });
