import { Hono } from "hono";
import { dismiss, pickUp, saveWrap, wrap } from "../handoff.ts";

// the end of the day and the start of the next: a line per live session on what's next, and picking them up
export const dayRoutes = new Hono()
  .post("/wrap", async (c) => c.json(await wrap()))
  .post("/wrap/save", async (c) => {
    const { items } = await c.req.json<{ items?: { id: string; next: string }[] }>();
    if (!Array.isArray(items)) return c.json({ error: "no items to save" }, 400);
    return c.json({ saved: saveWrap(items) });
  })
  .get("/handoffs", (c) => c.json(pickUp()))
  .post("/handoffs/dismiss", async (c) => {
    const { ids } = await c.req.json<{ ids?: string[] }>();
    if (!ids?.length) return c.json({ error: "nothing to dismiss" }, 400);
    dismiss(ids);
    return c.json({ ok: true });
  });
