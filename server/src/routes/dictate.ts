import { Hono } from "hono";
import { dictate, dictateHere } from "../dictate.ts";

// A few words said to a terminal, as text. here: asked by a hub for this machine to transcribe it
export const dictateRoutes = new Hono().post("/", async (c) => {
  const b = await c.req.json<{ data?: string; type?: string; here?: boolean }>().catch(() => ({}) as { data?: string; type?: string; here?: boolean });
  if (!b.data) return c.json({ error: "No audio came" }, 400);
  if (b.data.length > 20_000_000) return c.json({ error: "That's too long to say to a terminal" }, 413);
  try {
    return c.json(await (b.here ? dictateHere(b.data, b.type) : dictate(b.data, b.type)));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
