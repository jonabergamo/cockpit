import { Hono } from "hono";
import * as canvas from "../canvas.ts";
import { broadcast } from "../hub.ts";
import { listTerms, onTermsChanged } from "../pty.ts";

// every change is pushed, so other tabs and devices follow; by names the tab that made it, which already shows it
const changed = (by?: string) => broadcast({ type: "canvas", by });
const fail = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
type At = { x?: number; y?: number; by?: string };
const at = (b: At) => (Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: b.x!, y: b.y! } : undefined);

// The canvas follows the terminals from here on: new ones join it, closed ones leave it. It waits for the
// terminals reopened after a reboot first, or it would drop their cards before they're back.
export async function startCanvas(reopened: Promise<Map<string, string>> = Promise.resolve(new Map())) {
  canvas.rekeyTerms(await reopened);
  const sync = () => canvas.syncTerms(listTerms()) && changed();
  sync();
  onTermsChanged(sync);
}

export const canvasRoutes = new Hono()
  .get("/", (c) => c.json(canvas.listCanvases()))
  .post("/", async (c) => {
    const b = await c.req.json<{ name?: string; by?: string }>();
    const made = canvas.createCanvas(b.name ?? "Workspace");
    changed(b.by);
    return c.json(made);
  })
  .patch("/:id", async (c) => {
    const b = await c.req.json<{ name: string; by?: string }>();
    try {
      if (!canvas.renameCanvas(c.req.param("id"), b.name)) return c.json({ error: "No such workspace" }, 404);
    } catch (e) {
      return c.json(fail(e), 400);
    }
    changed(b.by);
    return c.json({ ok: true });
  })
  .delete("/:id", (c) => {
    try {
      if (!canvas.deleteCanvas(c.req.param("id"))) return c.json({ error: "No such workspace" }, 404);
    } catch (e) {
      return c.json(fail(e), 400);
    }
    changed();
    return c.json({ ok: true });
  })
  .put("/:id/layout", async (c) => {
    const b = await c.req.json<{ nodes: { id: string; x: number; y: number; w: number; h: number }[]; by?: string }>();
    canvas.saveLayout(c.req.param("id"), b.nodes ?? []);
    changed(b.by);
    return c.json({ ok: true });
  })
  .post("/:id/terms", async (c) => {
    const b = await c.req.json<At & { term: string }>();
    if (!listTerms().some((t) => t.id === b.term)) return c.json({ error: "That terminal isn't open" }, 404);
    try {
      const n = canvas.placeTerm(c.req.param("id"), b.term, at(b));
      changed(b.by);
      return c.json(n);
    } catch (e) {
      return c.json(fail(e), 404);
    }
  })
  .post("/:id/notes", async (c) => {
    const b = await c.req.json<At & { text?: string }>();
    try {
      const n = canvas.addNote(c.req.param("id"), at(b), b.text ?? "");
      changed(b.by);
      return c.json(n);
    } catch (e) {
      return c.json(fail(e), 404);
    }
  })
  .get("/nodes/:node/note", (c) => {
    const text = canvas.readNote(c.req.param("node"));
    return text === undefined ? c.json({ error: "No such note" }, 404) : c.json({ text });
  })
  .put("/nodes/:node/note", async (c) => {
    const b = await c.req.json<{ text: string }>();
    // the text isn't pushed: whoever has the note open keeps typing into their own copy
    return canvas.writeNote(c.req.param("node"), String(b.text ?? "")) ? c.json({ ok: true }) : c.json({ error: "No such note" }, 404);
  })
  .delete("/nodes/:node", (c) => {
    if (!canvas.removeNode(c.req.param("node"))) return c.json({ error: "No such card" }, 404);
    changed(c.req.query("by"));
    return c.json({ ok: true });
  });
