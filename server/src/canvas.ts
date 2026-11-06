// The Terminals canvas: workspaces of terminals, tickets and markdown notes, laid out where you put them and
// linked by the lines you draw between them. A terminal or a ticket sits on one workspace at a time. A terminal
// opened anywhere else in cockpit joins the canvas by itself: beside its ticket's card when it runs in that
// ticket's worktree, beside the terminal it was split from, on the Reviews workspace when it reviews a pull request,
// or else on the first workspace. So nothing running is ever off the canvas.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanvasEdge, CanvasInfo, CanvasNode, CanvasRelay, RelayStatus, TermInfo } from "@cockpit/shared";
import { paths } from "./config.ts";
import { db } from "./db.ts";

db.exec(`
  create table if not exists canvases (
    id text primary key,
    name text not null,
    position integer not null,
    created_at integer not null
  );
  create table if not exists canvas_nodes (
    id text primary key,
    canvas text not null,
    kind text not null,
    ref text not null,
    x real not null,
    y real not null,
    w real not null,
    h real not null,
    -- the machine a terminal runs on, so one whose node is out of reach isn't mistaken for closed
    node text,
    created_at integer not null
  );
  create index if not exists canvas_nodes_canvas on canvas_nodes (canvas);
  create table if not exists canvas_edges (
    id text primary key,
    canvas text not null,
    source text not null,
    target text not null,
    created_at integer not null
  );
  create index if not exists canvas_edges_canvas on canvas_edges (canvas);
`);
// lines between terminals can relay turns: how, and how many hops so far
for (const [col, type] of [
  ["relay", "text"],
  ["hops", "integer not null default 0"],
  // what happened to the last turn it had to pass on
  ["status", "text"],
] as const)
  if (!db.prepare<[], { name: string }>("pragma table_info(canvas_edges)").all().some((c) => c.name === col)) db.exec(`alter table canvas_edges add column ${col} ${type}`);
// a card that sizes its height to what it shows (0 once you size it yourself); unset is the card's own default
if (!db.prepare<[], { name: string }>("pragma table_info(canvas_nodes)").all().some((c) => c.name === "fit")) db.exec("alter table canvas_nodes add column fit integer");

export const TERM_W = 720;
export const TERM_H = 440;
export const NOTE_W = 320;
export const NOTE_H = 260;
export const TICKET_W = 340;
export const TICKET_H = 190;
export const CHANGES_W = 440;
export const CHANGES_H = 420;
export const RUNS_W = 440;
export const RUNS_H = 320;
const GAP = 40;

type NodeRow = Omit<CanvasNode, "fit"> & { canvas: string; fit: number | null };
type At = { x: number; y: number };

const notesDir = (canvas: string) => join(paths.data, "canvas", canvas);
const notePath = (canvas: string, file: string) => join(notesDir(canvas), file);

const COLS = "id, canvas, kind, ref, x, y, w, h, fit";
const rowsOf = (canvas: string) => db.prepare<[string], NodeRow>(`select ${COLS} from canvas_nodes where canvas = ? order by created_at`).all(canvas);
const nodeRow = (id: string) => db.prepare<[string], NodeRow>(`select ${COLS} from canvas_nodes where id = ?`).get(id);
const refRow = (kind: CanvasNode["kind"], ref: string) => db.prepare<[string, string], NodeRow>(`select ${COLS} from canvas_nodes where kind = ? and ref = ?`).get(kind, ref);
const canvasRow = (id: string) => db.prepare<[string], { id: string; name: string }>("select id, name from canvases where id = ?").get(id);
type EdgeRow = { id: string; source: string; target: string; relay: string | null; hops: number; status?: string | null };
// what each relay last did, kept with the line so a warning is still there after a restart
export const setRelayStatus = (edge: string, status: Omit<RelayStatus, "at">) => db.prepare("update canvas_edges set status = ? where id = ?").run(JSON.stringify({ ...status, at: Date.now() }), edge);
const toEdge = (e: EdgeRow): CanvasEdge => ({ id: e.id, source: e.source, target: e.target, ...(e.relay ? { relay: JSON.parse(e.relay) as CanvasRelay, hops: e.hops, ...(e.status ? { status: JSON.parse(e.status) as RelayStatus } : {}) } : {}) });
const edgesOf = (canvas: string) => db.prepare<[string], EdgeRow>("select id, source, target, relay, hops, status from canvas_edges where canvas = ? order by created_at").all(canvas).map(toEdge);
// every card but a terminal fits its content until you size it yourself
const strip = ({ canvas: _, fit, ...n }: NodeRow): CanvasNode => (n.kind === "term" ? n : { ...n, fit: fit !== 0 });

// there's always a first workspace, for the terminals opened elsewhere to land on
function first() {
  const row = db.prepare<[], { id: string }>("select id from canvases order by position, created_at limit 1").get();
  return row?.id ?? createCanvas("Main").id;
}

// where pull request reviews land, made the first time one starts (and again if it was deleted)
export const REVIEWS = "Reviews";
function reviewsCanvas() {
  const row = db.prepare<[string], { id: string }>("select id from canvases where lower(name) = lower(?) order by position, created_at limit 1").get(REVIEWS);
  return row?.id ?? createCanvas(REVIEWS).id;
}

// a line goes once either of its cards has left the workspace
const tidyEdges = () => db.exec("delete from canvas_edges where source not in (select id from canvas_nodes where canvas = canvas_edges.canvas) or target not in (select id from canvas_nodes where canvas = canvas_edges.canvas)");

export function listCanvases(): CanvasInfo[] {
  first();
  tidyEdges();
  return db
    .prepare<[], { id: string; name: string }>("select id, name from canvases order by position, created_at")
    .all()
    .map((c) => ({ ...c, nodes: rowsOf(c.id).map(strip), edges: edgesOf(c.id) }));
}

export function createCanvas(name: string): CanvasInfo {
  const id = randomUUID();
  const position = db.prepare<[], { n: number | null }>("select max(position) as n from canvases").get()?.n ?? -1;
  db.prepare("insert into canvases (id, name, position, created_at) values (?, ?, ?, ?)").run(id, name.trim() || "Workspace", position + 1, Date.now());
  return { id, name, nodes: [], edges: [] };
}

export function renameCanvas(id: string, name: string) {
  if (!name.trim()) throw new Error("A workspace needs a name");
  return db.prepare("update canvases set name = ? where id = ?").run(name.trim(), id).changes > 0;
}

// Its terminals keep running and move to the first workspace that's left, its tickets go with them; its notes
// and lines are deleted.
export function deleteCanvas(id: string) {
  if (!canvasRow(id)) return false;
  if (db.prepare<[], { n: number }>("select count(*) as n from canvases").get()!.n <= 1) throw new Error("The last workspace can't be deleted");
  const kept = rowsOf(id).filter((n) => n.kind === "term" || n.kind === "ticket");
  db.prepare("delete from canvas_nodes where canvas = ?").run(id);
  db.prepare("delete from canvas_edges where canvas = ?").run(id);
  db.prepare("delete from canvases where id = ?").run(id);
  rmSync(notesDir(id), { recursive: true, force: true });
  const to = first();
  for (const n of kept) place(to, n.kind, n.ref, n.w, n.h);
  return true;
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;

// The first free cell of a grid three cards wide, so new cards never land on top of what's there
export function freeSpot(nodes: Pick<CanvasNode, "x" | "y" | "w" | "h">[], w: number, h: number, near?: At) {
  if (near) {
    for (let i = 0; i < 20; i++) {
      const spot = { x: near.x + i * (w + GAP), y: near.y, w, h };
      if (!nodes.some((n) => overlaps(n, spot))) return { x: spot.x, y: spot.y };
    }
  }
  for (let row = 0; ; row++) {
    for (let col = 0; col < 3; col++) {
      const spot = { x: col * (TERM_W + GAP), y: row * (TERM_H + GAP), w, h };
      if (!nodes.some((n) => overlaps(n, spot))) return { x: spot.x, y: spot.y };
    }
  }
}

// at is where it was asked for (the middle of the screen, say); a card already there pushes it along to the right
function place(canvas: string, kind: CanvasNode["kind"], ref: string, w: number, h: number, at?: At) {
  const spot = freeSpot(rowsOf(canvas), w, h, at);
  const id = randomUUID();
  db.prepare("insert into canvas_nodes (id, canvas, kind, ref, x, y, w, h, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, canvas, kind, ref, spot.x, spot.y, w, h, Date.now());
  return strip({ id, canvas, kind, ref, x: spot.x, y: spot.y, w, h, fit: null });
}

// A terminal or a ticket onto a workspace, taken off the one it was on (and out of that one's lines)
function placeOne(canvas: string, kind: "term" | "ticket", ref: string, w: number, h: number, at?: At) {
  if (!canvasRow(canvas)) throw new Error("No such workspace");
  const old = refRow(kind, ref);
  if (old?.canvas === canvas) {
    if (!at) return strip(old);
    // moved to where it was asked for, or along to the right of a card already there, like a new one
    const spot = freeSpot(
      rowsOf(canvas).filter((n) => n.id !== old.id),
      old.w,
      old.h,
      at,
    );
    db.prepare("update canvas_nodes set x = ?, y = ? where id = ?").run(spot.x, spot.y, old.id);
    return strip({ ...old, ...spot });
  }
  if (old) {
    db.prepare("delete from canvas_nodes where id = ?").run(old.id);
    db.prepare("delete from canvas_edges where source = ? or target = ?").run(old.id, old.id);
  }
  return place(canvas, kind, ref, old?.w ?? w, old?.h ?? h, at);
}

export const placeTerm = (canvas: string, term: string, at?: At) => placeOne(canvas, "term", term, TERM_W, TERM_H, at);
export const placeTicket = (canvas: string, key: string, at?: At) => placeOne(canvas, "ticket", key.trim().toUpperCase(), TICKET_W, TICKET_H, at);
export const ticketCard = (key: string) => {
  const n = refRow("ticket", key);
  return n && { ...strip(n), canvas: n.canvas };
};

export function addNote(canvas: string, at?: At, text = "") {
  if (!canvasRow(canvas)) throw new Error("No such workspace");
  const file = `${randomUUID()}.md`;
  mkdirSync(notesDir(canvas), { recursive: true });
  writeFileSync(notePath(canvas, file), text);
  return place(canvas, "note", file, NOTE_W, NOTE_H, at);
}

// A changes card shows the branch of what it's linked to, a runs card its runs (tests, lint, e2e, CI...). Given a
// card to link it to, it goes under that card, beside any other card already hanging there.
function addPanel(kind: "changes" | "runs", w: number, h: number, canvas: string, at?: At, link?: string) {
  if (!canvasRow(canvas)) throw new Error("No such workspace");
  const to = link ? nodeRow(link) : undefined;
  if (link && to?.canvas !== canvas) throw new Error("That card isn't on this workspace");
  const n = place(canvas, kind, randomUUID(), w, h, to ? { x: to.x, y: to.y + to.h + GAP } : at);
  return { node: n, edge: to ? addEdge(canvas, to.id, n.id) : undefined };
}
export const addChanges = (canvas: string, at?: At, link?: string) => addPanel("changes", CHANGES_W, CHANGES_H, canvas, at, link);
export const addRuns = (canvas: string, at?: At, link?: string) => addPanel("runs", RUNS_W, RUNS_H, canvas, at, link);

export function readNote(node: string) {
  const n = nodeRow(node);
  if (n?.kind !== "note") return;
  try {
    return readFileSync(notePath(n.canvas, n.ref), "utf8");
  } catch {
    return "";
  }
}

export function writeNote(node: string, text: string) {
  const n = nodeRow(node);
  if (n?.kind !== "note") return false;
  mkdirSync(notesDir(n.canvas), { recursive: true });
  writeFileSync(notePath(n.canvas, n.ref), text);
  return true;
}

// A note goes with its file, a ticket card only leaves the canvas (the ticket stays where it is). A terminal can't
// leave the canvas while it runs, only move to another workspace, so this only takes it off once it's closed.
export function removeNode(id: string) {
  const n = nodeRow(id);
  if (!n) return false;
  db.prepare("delete from canvas_nodes where id = ?").run(id);
  db.prepare("delete from canvas_edges where source = ? or target = ?").run(id, id);
  if (n.kind === "note") rmSync(notePath(n.canvas, n.ref), { force: true });
  return true;
}

// A line between two cards of the same workspace. Drawing one that's already there (either way round) keeps that one.
export function addEdge(canvas: string, source: string, target: string): CanvasEdge {
  if (source === target) throw new Error("A card can't be linked to itself");
  const a = nodeRow(source);
  const b = nodeRow(target);
  if (a?.canvas !== canvas || b?.canvas !== canvas) throw new Error("Both cards have to be on this workspace");
  const had = db.prepare<[string, string, string, string], CanvasEdge>("select id, source, target from canvas_edges where (source = ? and target = ?) or (source = ? and target = ?)").get(source, target, target, source);
  if (had) return had;
  const id = randomUUID();
  db.prepare("insert into canvas_edges (id, canvas, source, target, created_at) values (?, ?, ?, ?, ?)").run(id, canvas, source, target, Date.now());
  return { id, source, target };
}

export const removeEdge = (id: string) => db.prepare("delete from canvas_edges where id = ?").run(id).changes > 0;

const ROLES = new Set(["review", "plan", "build", "custom"]);
const FROM = new Set(["source", "target", "both"]);

// Turns a line between two terminals into a relay, or back into a plain line (null). Changing it starts the count again.
export function setRelay(id: string, relay: CanvasRelay | null) {
  const e = db.prepare<[string], EdgeRow>("select id, source, target, relay, hops from canvas_edges where id = ?").get(id);
  if (!e) return false;
  if (relay) {
    if (nodeRow(e.source)?.kind !== "term" || nodeRow(e.target)?.kind !== "term") throw new Error("Only a line between two terminals can relay");
    if (!FROM.has(relay.from) || !ROLES.has(relay.role)) throw new Error("That isn't a way to relay");
    if (relay.role === "custom" && !relay.prompt?.trim()) throw new Error("Say what the other end should do with it");
    const limit = Math.min(Math.max(Math.round(Number(relay.limit) || 3), 1), 20);
    relay = { from: relay.from, role: relay.role, limit, ...(relay.role === "custom" ? { prompt: relay.prompt!.trim().slice(0, 2000) } : {}), ...(relay.when === "passing" ? { when: "passing" as const } : {}) };
  }
  // set up again, it starts with nothing to report
  db.prepare("update canvas_edges set relay = ?, hops = 0, status = null where id = ?").run(relay ? JSON.stringify(relay) : null, id);
  return true;
}

// The relays a finished turn in this terminal goes along: the terminal at the other end, and how
export function relaysFrom(term: string) {
  const card = refRow("term", term);
  if (!card) return [];
  return db
    .prepare<[string, string], EdgeRow>("select id, source, target, relay, hops from canvas_edges where relay is not null and (source = ? or target = ?)")
    .all(card.id, card.id)
    .map(toEdge)
    .filter((e) => e.relay!.from === "both" || (e.relay!.from === "source" ? e.source === card.id : e.target === card.id))
    .flatMap((e) => {
      const other = nodeRow(e.source === card.id ? e.target : e.source);
      // toEnd: which end of the line the turn goes to
      return other?.kind === "term" ? [{ edge: e, to: other.ref, toEnd: (e.source === card.id ? "target" : "source") as "source" | "target" }] : [];
    });
}

export const countHop = (edge: string) => db.prepare("update canvas_edges set hops = hops + 1 where id = ?").run(edge);

// you typed into this terminal: its relays start counting again. True when one had counted anything.
export function resetHops(term: string) {
  const card = refRow("term", term);
  if (!card) return false;
  return db.prepare("update canvas_edges set hops = 0 where relay is not null and hops > 0 and (source = ? or target = ?)").run(card.id, card.id).changes > 0;
}

// where cards were dragged or resized to, and whether each still fits its content; ids from another workspace are
// left alone. A card that fits its content sends its height as it grows, so new cards aren't placed over it.
export function saveLayout(canvas: string, nodes: (Pick<CanvasNode, "id" | "x" | "y" | "w" | "h"> & { fit?: boolean })[]) {
  const update = db.prepare("update canvas_nodes set x = ?, y = ?, w = ?, h = ?, fit = coalesce(?, fit) where id = ? and canvas = ?");
  db.transaction(() => {
    for (const n of nodes) if ([n.x, n.y, n.w, n.h].every(Number.isFinite)) update.run(n.x, n.y, Math.max(160, n.w), Math.max(80, n.h), typeof n.fit === "boolean" ? Number(n.fit) : null, n.id, canvas);
  })();
}

// After a reboot each terminal comes back with a new id; its card follows it, so it stays where you left it
export function rekeyTerms(ids: Map<string, string>) {
  const move = db.prepare("update canvas_nodes set ref = ? where kind = 'term' and ref = ?");
  db.transaction(() => {
    for (const [from, to] of ids) move.run(to, from);
  })();
}

// Keeps the canvas in step with the terminals: each new one joins the canvas (beside its ticket's card when it runs
// in that ticket's worktree, beside the terminal it was split from, on Reviews for a PR review, or on the first
// workspace), and the cards of
// closed ones go. A node's terminals are only dropped while that node is listing some: until its link is up its
// list is missing, and those still run.
export function syncTerms(terms: TermInfo[], ticketOf: (t: TermInfo) => string | undefined = () => undefined, isReview: (t: TermInfo) => boolean = () => false) {
  type Placed = NodeRow & { node: string | null };
  const placed = new Map(db.prepare<[], Placed>(`select ${COLS}, node from canvas_nodes where kind = 'term'`).all().map((n) => [n.ref, n]));
  let changed = false;
  // a terminal reopened after a reboot (a node's, which the hub only hears of as a new one) takes the card it had
  const rekey = db.prepare("update canvas_nodes set ref = ? where kind = 'term' and ref = ?");
  for (const t of terms) {
    const old = t.was ? placed.get(t.was) : undefined;
    if (!old || placed.has(t.id)) continue;
    rekey.run(t.id, t.was);
    placed.delete(t.was!);
    placed.set(t.id, { ...old, ref: t.id });
    changed = true;
  }
  const byId = new Map(terms.map((t) => [t.id, t]));
  const listing = new Set(terms.map((t) => t.node ?? "local"));
  const setNode = db.prepare("update canvas_nodes set node = ? where id = ?");
  for (const [ref, n] of placed) {
    const t = byId.get(ref);
    if (t) {
      if ((t.node ?? "local") !== n.node) setNode.run(t.node ?? "local", n.id);
      continue;
    }
    const node = n.node ?? "local";
    if (node !== "local" && !listing.has(node)) continue;
    db.prepare("delete from canvas_nodes where id = ?").run(n.id);
    placed.delete(ref);
    changed = true;
  }
  const to = first();
  // parents first, so a split shell can sit next to the one it came from
  for (const t of [...terms].sort((a, b) => Number(!!a.parent) - Number(!!b.parent))) {
    if (placed.has(t.id)) continue;
    const key = ticketOf(t);
    const ticket = key ? refRow("ticket", key) : undefined;
    const beside = t.parent ? placed.get(t.parent) : ticket;
    const canvas = beside?.canvas ?? (isReview(t) ? reviewsCanvas() : to);
    const n = place(canvas, "term", t.id, TERM_W, TERM_H, beside && { x: beside.x + beside.w + GAP, y: beside.y });
    setNode.run(t.node ?? "local", n.id);
    placed.set(t.id, { ...n, canvas, fit: null, node: t.node ?? "local" });
    changed = true;
  }
  if (changed) tidyEdges();
  return changed;
}
