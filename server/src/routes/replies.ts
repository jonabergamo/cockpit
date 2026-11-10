import { Hono } from "hono";
import { chipsFrom, rankReplies } from "../replies.ts";
import { frequentEverywhere } from "../remote/sessions.ts";
import { getSettings } from "../settings.ts";

export const replies = new Hono()
  .get("/frequent", async (c) => {
    const s = getSettings().replies;
    return c.json({ on: s.on, chips: s.on ? chipsFrom(await frequentEverywhere(), s) : [] });
  })
  // null leaves them by how often you use them
  .post("/rank", async (c) => {
    const { last, texts } = await c.req.json<{ last?: string; texts?: string[] }>();
    return c.json({ order: (await rankReplies(last ?? "", (texts ?? []).slice(0, 20))) ?? null });
  });
