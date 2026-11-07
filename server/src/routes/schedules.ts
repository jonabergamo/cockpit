import { Hono } from "hono";
import { allowedRoot, gitRoot, insideSaved } from "../files.ts";
import { config } from "../config.ts";
import { addSchedule, listSchedules, removeSchedule, runSchedule, updateSchedule, type ScheduleInput } from "../schedules.ts";

const fail = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
// a folder on this machine has to be one cockpit opens terminals in; a node's own folders are the node's to say
const allowed = async (cwd?: string, node?: string) => !cwd || (node && node !== "local") || (await allowedRoot(cwd)) || cwd === config.repo.path || insideSaved(cwd) || (await allowedRoot((await gitRoot(cwd)) ?? cwd));

export const scheduleRoutes = new Hono()
  .get("/", (c) => c.json(listSchedules()))
  .post("/", async (c) => {
    const b = await c.req.json<ScheduleInput>();
    if (!(await allowed(b.cwd, b.node))) return c.json({ error: "cockpit doesn't open terminals in that folder" }, 403);
    try {
      return c.json(addSchedule(b));
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
  .patch("/:id", async (c) => {
    const b = await c.req.json<Partial<ScheduleInput>>();
    if (!(await allowed(b.cwd, b.node))) return c.json({ error: "cockpit doesn't open terminals in that folder" }, 403);
    try {
      const s = updateSchedule(c.req.param("id"), b);
      return s ? c.json(s) : c.notFound();
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
  .delete("/:id", (c) => (removeSchedule(c.req.param("id")) ? c.json({ ok: true }) : c.notFound()))
  // now, whatever its time: to try one out
  .post("/:id/run", async (c) => {
    try {
      return c.json(await runSchedule(c.req.param("id")));
    } catch (e) {
      return c.json(fail(e), 400);
    }
  });
