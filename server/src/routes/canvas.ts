import { Hono } from "hono";
import type { CanvasRelay, TermInfo, Worktree } from "@cockpit/shared";
import * as canvas from "../canvas.ts";
import { broadcast } from "../hub.ts";
import { currentCwd, listTerms, onTermsChanged, spawnTerm } from "../pty.ts";
import { allWorktrees } from "../remote/work.ts";
import { away } from "../away.ts";
import { isReviewTerm } from "../reviews.ts";
import { handOff, joinPanel, replay, sendSpec } from "../relay.ts";
import { canvasView, findCard, openBeside, type BesideAgent, type BesideAs, type FindCtx } from "../canvasTools.ts";
import { listSessions } from "../claude/sessions.ts";
import { config } from "../config.ts";
import { cwdAllowed } from "../files.ts";
import { spawnRemote } from "../remote/terminals.ts";
import { getSettings } from "../settings.ts";
import { listTasks } from "../tasks.ts";

// every change is pushed, so other tabs and devices follow; by names the tab that made it, which already shows it
const changed = (by?: string) => broadcast({ type: "canvas", by });
const fail = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
type At = { x?: number; y?: number; by?: string };
const at = (b: At) => (Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: b.x!, y: b.y! } : undefined);

const within = (path: string, root: string) => path === root || path.startsWith(root + "/");

// the ticket a terminal works on: the one whose worktree it sits in, on the same machine
export const ticketOfTerm = (worktrees: Worktree[]) => (t: TermInfo) =>
  worktrees.find((w) => !w.main && w.ticket && (w.node ?? "local") === (t.node ?? "local") && within(t.cwd, w.path))?.ticket;

// the repo or worktree a terminal runs in, on its machine: the deepest one its folder is in, or else the folder
export const repoOfTerm = (worktrees: Worktree[]) => (t: TermInfo) => {
  const node = t.node ?? "local";
  const w = worktrees.filter((x) => (x.node ?? "local") === node && within(t.cwd, x.path)).sort((a, b) => b.path.length - a.path.length)[0];
  const path = w?.path ?? t.cwd;
  return { key: `${node}:${path}`, name: w?.name ?? (path.split("/").filter(Boolean).pop() || path) };
};

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

// what a worker can be named by, for the lead's tools
const findCtx = (): FindCtx => ({ canvases: canvas.listCanvases(), terms: listTerms(), tasks: listTasks(), sessions: listSessions({ limit: 800 }) });

export const canvasRoutes = new Hono()
  .get("/", (c) => c.json(canvas.listCanvases()))
  // the lead's view: each workspace's cards and lines in a few words
  .get("/view", (c) => c.json(canvasView(canvas.listCanvases(), listTerms(), canvas.readNote, c.req.query("workspace") || undefined)))
  // the card a worker is on, by its task, session, worktree, terminal or card id
  .get("/find", (c) => {
    try {
      const f = findCard(c.req.query("who") ?? "", findCtx());
      return c.json({ canvas: f.canvas, workspace: f.workspace, node: f.node, term: f.term });
    } catch (e) {
      return c.json(fail(e), 404);
    }
  })
  // Codex or the local model beside a worker, as its card's + menu opens them
  .post("/beside", async (c) => {
    const b = await c.req.json<{ who?: string; agent?: BesideAgent; as?: BesideAs; by?: string }>();
    if (b.agent !== "codex" && b.agent !== "local") return c.json({ error: "agent is codex or local" }, 400);
    try {
      const made = await openBeside(findCard(b.who ?? "", findCtx()), b.agent, b.as ?? "chat", {
        quick: getSettings().quick,
        base: config.repo.baseBranch,
        cwdNow: currentCwd,
        spawn: async ({ node, ...opts }) => {
          if (node) return spawnRemote(node, opts);
          if (!(await cwdAllowed(opts.cwd))) throw new Error(`cockpit doesn't open terminals in ${opts.cwd}`);
          return spawnTerm(opts);
        },
      });
      changed(b.by);
      return c.json(made);
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
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
  // the workspace tidied: a block for each ticket and each repo, three down a column, as one change
  .post("/:id/arrange", async (c) => {
    const b = await c.req.json<{ by?: string }>().catch(() => ({}) as { by?: string });
    try {
      const worktrees = await allWorktrees(false).catch(() => []);
      // a reviewer is a PR review, one a review line hands turns to, or one named as such ("reviewer · ...")
      const lines = canvas.reviewersOn(c.req.param("id"));
      const reviews = (t: TermInfo) => isReviewTerm(t) || lines.has(t.id) || /^review(er)?\b/i.test(t.title);
      const nodes = canvas.arrange(c.req.param("id"), listTerms(), ticketOfTerm(worktrees), reviews, repoOfTerm(worktrees));
      changed(b.by);
      return c.json({ nodes });
    } catch (e) {
      return c.json(fail(e), 400);
    }
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
  // a terminal put away without closing it, with the cards linked to it folded in; or taken back out
  .post("/nodes/:id/archive", async (c) => {
    const b = await c.req.json<{ archived?: boolean; nodes?: string[]; by?: string }>();
    try {
      if (b.archived === false) canvas.unarchive(c.req.param("id"));
      else canvas.archive(c.req.param("id"), Array.isArray(b.nodes) ? b.nodes.filter((n) => typeof n === "string") : []);
      changed(b.by);
      return c.json({ ok: true });
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
  // cards that go together, onto this workspace, their middle where it says (or clear of what's there)
  .post("/:id/group", async (c) => {
    const b = await c.req.json<At & { nodes: string[] }>();
    if (!Array.isArray(b.nodes) || !b.nodes.every((n) => typeof n === "string")) return c.json({ error: "nodes is a list of card ids" }, 400);
    try {
      const moved = canvas.moveGroup(c.req.param("id"), b.nodes, at(b));
      changed(b.by);
      return c.json({ nodes: moved });
    } catch (e) {
      return c.json(fail(e), 400);
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
  .post("/:id/plan", async (c) => {
    const b = await c.req.json<At & { link?: string }>();
    try {
      const made = canvas.addPlan(c.req.param("id"), at(b), b.link);
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
  // the last answer of the terminal at one end, handed to the other once
  .post("/edges/:edge/handoff", async (c) => {
    const b = await c.req.json<{ from?: "source" | "target"; ask?: string; by?: string }>();
    try {
      await handOff(c.req.param("edge"), b.from === "target" ? "target" : "source", typeof b.ask === "string" ? b.ask : undefined);
      changed(b.by);
      return c.json({ ok: true });
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
  // everything the line carried or held back, oldest first
  .get("/edges/:edge/log", (c) => {
    if (!canvas.edgeCards(c.req.param("edge"))) return c.json({ error: "No such line" }, 404);
    return c.json(canvas.relayLog(c.req.param("edge")));
  })
  // one message from a line's history sent again, to where it went or to another terminal card (to)
  .post("/log/:id/replay", async (c) => {
    const b = await c.req.json<{ to?: string; by?: string }>();
    try {
      const sent = await replay(Number(c.req.param("id")), typeof b.to === "string" ? b.to : undefined);
      changed(b.by);
      return c.json(sent);
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
  // a review line reviews together with another from the same terminal (with), or leaves its panel (null)
  .post("/edges/:edge/panel", async (c) => {
    const b = await c.req.json<{ with?: string | null; by?: string }>();
    try {
      if (!canvas.edgeById(c.req.param("edge"))) return c.json({ error: "No such line" }, 404);
      joinPanel(c.req.param("edge"), typeof b.with === "string" ? b.with : null);
    } catch (e) {
      return c.json(fail(e), 400);
    }
    changed(b.by);
    return c.json({ ok: true, relay: canvas.edgeById(c.req.param("edge"))?.relay });
  })
  // a line between a note and a terminal makes the note that terminal's spec, or stops it being one
  .patch("/edges/:edge/spec", async (c) => {
    const b = await c.req.json<{ spec?: boolean; by?: string }>();
    try {
      if (!canvas.setEdgeSpec(c.req.param("edge"), b.spec !== false)) return c.json({ error: "No such line" }, 404);
    } catch (e) {
      return c.json(fail(e), 400);
    }
    changed(b.by);
    return c.json({ ok: true });
  })
  // the terminals a note is the spec of, all at once (lines are drawn to the new ones)
  .put("/nodes/:node/spec", async (c) => {
    const b = await c.req.json<{ cards?: string[]; by?: string }>();
    if (!Array.isArray(b.cards) || !b.cards.every((x) => typeof x === "string")) return c.json({ error: "cards is a list of terminal card ids" }, 400);
    try {
      const ends = canvas.setSpec(c.req.param("node"), b.cards);
      changed(b.by);
      return c.json({ ends });
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
  // the note's spec sent once to every terminal it's the spec of, to start from
  .post("/nodes/:node/spec/send", async (c) => {
    const b = await c.req.json<{ by?: string }>().catch(() => ({}) as { by?: string });
    try {
      const out = await sendSpec(c.req.param("node"));
      changed(b.by);
      return c.json(out);
    } catch (e) {
      return c.json(fail(e), 400);
    }
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
