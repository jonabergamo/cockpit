// The Terminals canvas: workspaces of terminals and markdown notes, laid out where you put them.
// A terminal sits on one workspace at a time. One opened anywhere else in cockpit joins the first workspace by
// itself, next to the terminal it was split from when it has one, so nothing running is ever off the canvas.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanvasInfo, CanvasNode, TermInfo } from "@cockpit/shared";
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
`);

export const TERM_W = 720;
export const TERM_H = 440;
export const NOTE_W = 320;
export const NOTE_H = 260;
const GAP = 40;

type NodeRow = CanvasNode & { canvas: string };

const notesDir = (canvas: string) => join(paths.data, "canvas", canvas);
const notePath = (canvas: string, file: string) => join(notesDir(canvas), file);

const rowsOf = (canvas: string) => db.prepare<[string], NodeRow>("select id, canvas, kind, ref, x, y, w, h from canvas_nodes where canvas = ? order by created_at").all(canvas);
const nodeRow = (id: string) => db.prepare<[string], NodeRow>("select id, canvas, kind, ref, x, y, w, h from canvas_nodes where id = ?").get(id);
const canvasRow = (id: string) => db.prepare<[string], { id: string; name: string }>("select id, name from canvases where id = ?").get(id);
const strip = ({ canvas: _, ...n }: NodeRow): CanvasNode => n;

// there's always a first workspace, for the terminals opened elsewhere to land on
function first() {
  const row = db.prepare<[], { id: string }>("select id from canvases order by position, created_at limit 1").get();
  return row?.id ?? createCanvas("Main").id;
}

export function listCanvases(): CanvasInfo[] {
  first();
  return db
    .prepare<[], { id: string; name: string }>("select id, name from canvases order by position, created_at")
    .all()
    .map((c) => ({ ...c, nodes: rowsOf(c.id).map(strip) }));
}

export function createCanvas(name: string): CanvasInfo {
  const id = randomUUID();
  const position = db.prepare<[], { n: number | null }>("select max(position) as n from canvases").get()?.n ?? -1;
  db.prepare("insert into canvases (id, name, position, created_at) values (?, ?, ?, ?)").run(id, name.trim() || "Workspace", position + 1, Date.now());
  return { id, name, nodes: [] };
}

export function renameCanvas(id: string, name: string) {
  if (!name.trim()) throw new Error("A workspace needs a name");
  return db.prepare("update canvases set name = ? where id = ?").run(name.trim(), id).changes > 0;
}

// Its terminals keep running and move to the first workspace that's left; its notes go with it.
export function deleteCanvas(id: string) {
  if (!canvasRow(id)) return false;
  if (db.prepare<[], { n: number }>("select count(*) as n from canvases").get()!.n <= 1) throw new Error("The last workspace can't be deleted");
  const terms = rowsOf(id).filter((n) => n.kind === "term");
  db.prepare("delete from canvas_nodes where canvas = ?").run(id);
  db.prepare("delete from canvases where id = ?").run(id);
  rmSync(notesDir(id), { recursive: true, force: true });
  const to = first();
  for (const t of terms) place(to, "term", t.ref, t.w, t.h);
  return true;
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;

// The first free cell of a grid three cards wide, so new cards never land on top of what's there
export function freeSpot(nodes: Pick<CanvasNode, "x" | "y" | "w" | "h">[], w: number, h: number, near?: { x: number; y: number }) {
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
function place(canvas: string, kind: CanvasNode["kind"], ref: string, w: number, h: number, at?: { x: number; y: number }, near?: { x: number; y: number }) {
  const spot = freeSpot(rowsOf(canvas), w, h, at ?? near);
  const id = randomUUID();
  db.prepare("insert into canvas_nodes (id, canvas, kind, ref, x, y, w, h, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, canvas, kind, ref, spot.x, spot.y, w, h, Date.now());
  return { id, kind, ref, x: spot.x, y: spot.y, w, h } satisfies CanvasNode;
}

// A terminal onto a workspace, taken off the one it was on
export function placeTerm(canvas: string, term: string, at?: { x: number; y: number }) {
  if (!canvasRow(canvas)) throw new Error("No such workspace");
  const old = db.prepare<[string], NodeRow>("select id, canvas, kind, ref, x, y, w, h from canvas_nodes where kind = 'term' and ref = ?").get(term);
  if (old?.canvas === canvas) {
    if (at) db.prepare("update canvas_nodes set x = ?, y = ? where id = ?").run(at.x, at.y, old.id);
    return strip({ ...old, ...at });
  }
  if (old) db.prepare("delete from canvas_nodes where id = ?").run(old.id);
  return place(canvas, "term", term, old?.w ?? TERM_W, old?.h ?? TERM_H, at);
}

export function addNote(canvas: string, at?: { x: number; y: number }, text = "") {
  if (!canvasRow(canvas)) throw new Error("No such workspace");
  const file = `${randomUUID()}.md`;
  mkdirSync(notesDir(canvas), { recursive: true });
  writeFileSync(notePath(canvas, file), text);
  return place(canvas, "note", file, NOTE_W, NOTE_H, at);
}

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

// A note goes with its file. A terminal can't leave the canvas while it runs, only move to another workspace,
// so this only takes it off once it's closed.
export function removeNode(id: string) {
  const n = nodeRow(id);
  if (!n) return false;
  db.prepare("delete from canvas_nodes where id = ?").run(id);
  if (n.kind === "note") rmSync(notePath(n.canvas, n.ref), { force: true });
  return true;
}

// where cards were dragged or resized to; ids from another workspace are left alone
export function saveLayout(canvas: string, nodes: Pick<CanvasNode, "id" | "x" | "y" | "w" | "h">[]) {
  const update = db.prepare("update canvas_nodes set x = ?, y = ?, w = ?, h = ? where id = ? and canvas = ?");
  db.transaction(() => {
    for (const n of nodes) if ([n.x, n.y, n.w, n.h].every(Number.isFinite)) update.run(n.x, n.y, Math.max(160, n.w), Math.max(120, n.h), n.id, canvas);
  })();
}

// After a reboot each terminal comes back with a new id; its card follows it, so it stays where you left it
export function rekeyTerms(ids: Map<string, string>) {
  const move = db.prepare("update canvas_nodes set ref = ? where kind = 'term' and ref = ?");
  db.transaction(() => {
    for (const [from, to] of ids) move.run(to, from);
  })();
}

// Keeps the canvas in step with the terminals: each new one joins the first workspace (beside the one it was
// split from), and the cards of closed ones go. A node's terminals are only dropped while that node is listing
// some: until its link is up its list is missing, and those still run.
export function syncTerms(terms: TermInfo[]) {
  type Placed = NodeRow & { node: string | null };
  const placed = new Map(db.prepare<[], Placed>("select id, canvas, kind, ref, x, y, w, h, node from canvas_nodes where kind = 'term'").all().map((n) => [n.ref, n]));
  const byId = new Map(terms.map((t) => [t.id, t]));
  const listing = new Set(terms.map((t) => t.node ?? "local"));
  const setNode = db.prepare("update canvas_nodes set node = ? where id = ?");
  let changed = false;
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
    const parent = t.parent ? placed.get(t.parent) : undefined;
    const canvas = parent?.canvas ?? to;
    const n = place(canvas, "term", t.id, TERM_W, TERM_H, undefined, parent && { x: parent.x + parent.w + GAP, y: parent.y });
    setNode.run(t.node ?? "local", n.id);
    placed.set(t.id, { ...n, canvas, node: t.node ?? "local" });
    changed = true;
  }
  return changed;
}
