import { Hono } from "hono";
import type { CanvasRelay, TermInfo, Worktree } from "@cockpit/shared";
import * as canvas from "../canvas.ts";
import { broadcast } from "../hub.ts";
import { listTerms, onTermsChanged } from "../pty.ts";
import { allWorktrees } from "../remote/work.ts";
import { away } from "../away.ts";
import { isReviewTerm } from "../reviews.ts";

// every change is pushed, so other tabs and devices follow; by names the tab that made it, which already shows it
const changed = (by?: string) => broadcast({ type: "canvas", by });
const fail = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
type At = { x?: number; y?: number; by?: string };
const at = (b: At) => (Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: b.x!, y: b.y! } : undefined);

const within = (path: string, root: string) => path === root || path.startsWith(root + "/");

// the ticket a terminal works on: the one whose worktree it sits in, on the same machine
export const ticketOfTerm = (worktrees: Worktree[]) => (t: TermInfo) =>
  worktrees.find((w) => !w.main && w.ticket && (w.node ?? "local") === (t.node ?? "local") && within(t.cwd, w.path))?.ticket;

// The canvas follows the terminals from here on: new ones join it, closed ones leave it. It waits for the
// terminals reopened after a reboot first, or it would drop their cards before they're back.
export async function startCanvas(reopened: Promise<Map<string, string>> = Promise.resolve(new Map())) {
  canvas.rekeyTerms(await reopened);
  // one at a time: the worktrees are read on every change, and two going at once would place a terminal twice
  let queue = Promise.resolve();
  const sync = () =>
    (queue = queue.then(async () => {
      const worktrees = await allWorktrees(false).catch(() => []);
      if (canvas.syncTerms(listTerms(), ticketOfTerm(worktrees), isReviewTerm)) changed();
    }));
  await sync();
  onTermsChanged(() => void sync());
}

export const canvasRoutes = new Hono()
  .get("/", (c) => c.json(canvas.listCanvases()))
  // what the agents on a workspace did since you last looked
  .get("/:id/away", async (c) => {
    const ws = canvas.listCanvases().find((x) => x.id === c.req.param("id"));
    if (!ws) return c.json({ error: "No such workspace" }, 404);
    const since = Number(c.req.query("since"));
    if (!Number.isFinite(since) || since <= 0) return c.json({ error: "since is a time in ms" }, 400);
    return c.json(await away(ws.nodes.filter((n) => n.kind === "term").map((n) => n.ref), since));
  })
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
    const b = await c.req.json<{ nodes: { id: string; x: number; y: number; w: number; h: number; fit?: boolean }[]; by?: string }>();
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
  .post("/:id/tickets", async (c) => {
    const b = await c.req.json<At & { key: string }>();
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(b.key?.trim() ?? "")) return c.json({ error: "That isn't a ticket key" }, 400);
    try {
      const n = canvas.placeTicket(c.req.param("id"), b.key, at(b));
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
  .post("/:id/changes", async (c) => {
    const b = await c.req.json<At & { link?: string }>();
    try {
      const made = canvas.addChanges(c.req.param("id"), at(b), b.link);
      changed(b.by);
      return c.json(made);
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
  .post("/:id/runs", async (c) => {
    const b = await c.req.json<At & { link?: string }>();
    try {
      const made = canvas.addRuns(c.req.param("id"), at(b), b.link);
      changed(b.by);
      return c.json(made);
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
  .post("/:id/edges", async (c) => {
    const b = await c.req.json<{ source: string; target: string; by?: string }>();
    try {
      const e = canvas.addEdge(c.req.param("id"), b.source, b.target);
      changed(b.by);
      return c.json(e);
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
  // a line between two terminals made a relay, or a plain line again with null
  .patch("/edges/:edge", async (c) => {
    const b = await c.req.json<{ relay: CanvasRelay | null; by?: string }>();
    try {
      if (!canvas.setRelay(c.req.param("edge"), b.relay ?? null)) return c.json({ error: "No such line" }, 404);
    } catch (e) {
      return c.json(fail(e), 400);
    }
    changed(b.by);
    return c.json({ ok: true });
  })
  .delete("/edges/:edge", (c) => {
    if (!canvas.removeEdge(c.req.param("edge"))) return c.json({ error: "No such line" }, 404);
    changed(c.req.query("by"));
    return c.json({ ok: true });
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
