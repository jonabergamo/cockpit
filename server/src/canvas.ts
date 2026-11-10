// The Terminals canvas: workspaces of terminals, tickets and markdown notes, laid out where you put them and
// linked by the lines you draw between them. A terminal or a ticket sits on one workspace at a time. A terminal
// opened anywhere else in cockpit joins the canvas by itself: beside its ticket's card when it runs in that
// ticket's worktree, beside the terminal it was split from, on the Reviews workspace when it reviews a pull request,
// or else on the first workspace. So nothing running is ever off the canvas.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanvasEdge, CanvasInfo, CanvasNode, CanvasRelay, PanelPart, RelayLogEntry, RelayStatus, TermInfo } from "@cockpit/shared";
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
// every message a line carried or held back, not only the last, so the back-and-forth can be read and sent again
db.exec(`
  create table if not exists canvas_relay_log (
    id integer primary key autoincrement,
    edge text not null,
    hop integer not null,
    hop_limit integer,
    from_node text not null,
    to_node text not null,
    kind text not null,
    text text not null,
    at integer not null,
    outcome text not null,
    note text,
    replay integer
  );
  create index if not exists canvas_relay_log_edge on canvas_relay_log (edge, id);
`);
// a panel's entry keeps each reviewer's own review beside the merged one
if (!db.prepare<[], { name: string }>("pragma table_info(canvas_relay_log)").all().some((c) => c.name === "parts")) db.exec("alter table canvas_relay_log add column parts text");
// the notes that went with an entry as the spec, by card id: the text itself is in the note, not copied each time
if (!db.prepare<[], { name: string }>("pragma table_info(canvas_relay_log)").all().some((c) => c.name === "spec")) db.exec("alter table canvas_relay_log add column spec text");
// lines between terminals can relay turns: how, and how many hops so far
for (const [col, type] of [
  ["relay", "text"],
  ["hops", "integer not null default 0"],
  // what happened to the last turn it had to pass on
  ["status", "text"],
  // a line from a note to a terminal: the note is the spec of that terminal's relay lines
  ["spec", "integer"],
] as const)
  if (!db.prepare<[], { name: string }>("pragma table_info(canvas_edges)").all().some((c) => c.name === col)) db.exec(`alter table canvas_edges add column ${col} ${type}`);
// a card that sizes its height to what it shows (0 once you size it yourself); unset is the card's own default
if (!db.prepare<[], { name: string }>("pragma table_info(canvas_nodes)").all().some((c) => c.name === "fit")) db.exec("alter table canvas_nodes add column fit integer");
// archived: { at, head, and for the head its size before it was folded: w, h }
if (!db.prepare<[], { name: string }>("pragma table_info(canvas_nodes)").all().some((c) => c.name === "archived")) db.exec("alter table canvas_nodes add column archived text");

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
export const PLAN_W = 380;
export const PLAN_H = 360;
const GAP = 40;

type NodeRow = Omit<CanvasNode, "fit" | "archived"> & { canvas: string; fit: number | null; archived?: string | null };
type Archived = { at: number; head: string; w?: number; h?: number };
export const ARCHIVED_W = 340;
export const ARCHIVED_H = 190;
type At = { x: number; y: number };

const notesDir = (canvas: string) => join(paths.data, "canvas", canvas);
const notePath = (canvas: string, file: string) => join(notesDir(canvas), file);

const COLS = "id, canvas, kind, ref, x, y, w, h, fit, archived";
const rowsOf = (canvas: string) => db.prepare<[string], NodeRow>(`select ${COLS} from canvas_nodes where canvas = ? order by created_at`).all(canvas);
const nodeRow = (id: string) => db.prepare<[string], NodeRow>(`select ${COLS} from canvas_nodes where id = ?`).get(id);
const refRow = (kind: CanvasNode["kind"], ref: string) => db.prepare<[string, string], NodeRow>(`select ${COLS} from canvas_nodes where kind = ? and ref = ?`).get(kind, ref);
const canvasRow = (id: string) => db.prepare<[string], { id: string; name: string }>("select id, name from canvases where id = ?").get(id);
type EdgeRow = { id: string; source: string; target: string; relay: string | null; hops: number; status?: string | null; spec?: number | null };
// what each relay last did, kept with the line so a warning is still there after a restart
export const setRelayStatus = (edge: string, status: Omit<RelayStatus, "at">) => db.prepare("update canvas_edges set status = ? where id = ?").run(JSON.stringify({ ...status, at: Date.now() }), edge);
// a message carries a diff at most; the history keeps it whole up to this, and only so many per line
export const LOG_TEXT = 60_000;
export const LOG_KEEP = 200;
type LogRow = { id: number; edge: string; hop: number; hop_limit: number | null; from_node: string; to_node: string; kind: RelayLogEntry["kind"]; text: string; at: number; outcome: RelayLogEntry["outcome"]; note: string | null; replay: number | null; parts?: string | null; spec?: string | null };
const toLog = (r: LogRow): RelayLogEntry => ({
  id: r.id,
  edge: r.edge,
  hop: r.hop,
  ...(r.hop_limit != null ? { limit: r.hop_limit } : {}),
  from: r.from_node,
  to: r.to_node,
  kind: r.kind,
  text: r.text,
  at: r.at,
  outcome: r.outcome,
  ...(r.note ? { note: r.note } : {}),
  ...(r.replay != null ? { replay: r.replay } : {}),
  ...(r.parts ? { parts: JSON.parse(r.parts) as PanelPart[] } : {}),
  ...(r.spec ? { spec: JSON.parse(r.spec) as string[] } : {}),
});
export function logRelay(e: Omit<RelayLogEntry, "id" | "at"> & { at?: number }) {
  const text = e.text.length > LOG_TEXT ? `${e.text.slice(0, LOG_TEXT)}\n\n(cut short at ${LOG_TEXT / 1000}k characters in the line's history)` : e.text;
  const id = Number(
    db
      .prepare("insert into canvas_relay_log (edge, hop, hop_limit, from_node, to_node, kind, text, at, outcome, note, replay, parts, spec) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.edge, e.hop, e.limit ?? null, e.from, e.to, e.kind, text, e.at ?? Date.now(), e.outcome, e.note ?? null, e.replay ?? null, e.parts ? JSON.stringify(e.parts.map((p) => ({ ...p, ...(p.text ? { text: p.text.slice(0, LOG_TEXT / 4) } : {}) }))) : null, e.spec?.length ? JSON.stringify(e.spec) : null).lastInsertRowid,
  );
  db.prepare("delete from canvas_relay_log where edge = ? and id <= coalesce((select id from canvas_relay_log where edge = ? order by id desc limit 1 offset ?), -1)").run(e.edge, e.edge, LOG_KEEP);
  return id;
}
export const setLogOutcome = (id: number, outcome: RelayLogEntry["outcome"], note?: string) => db.prepare("update canvas_relay_log set outcome = ?, note = ? where id = ?").run(outcome, note ?? null, id);
export const relayLog = (edge: string) => db.prepare<[string], LogRow>("select * from canvas_relay_log where edge = ? order by id").all(edge).map(toLog);
export const logEntry = (id: number) => {
  const r = db.prepare<[number], LogRow>("select * from canvas_relay_log where id = ?").get(id);
  return r && toLog(r);
};
export const lastLog = (edge: string) => {
  const r = db.prepare<[string], LogRow>("select * from canvas_relay_log where edge = ? order by id desc limit 1").get(edge);
  return r && toLog(r);
};
// the last entry on each line, for the lead's view
export const lastLogs = () => new Map(db.prepare<[], LogRow>("select * from canvas_relay_log where id in (select max(id) from canvas_relay_log group by edge)").all().map((r) => [r.edge, toLog(r)]));
// a line says how the last thing it carried went: a relayed turn, or a last answer handed over along it
const toEdge = (e: EdgeRow): CanvasEdge => ({ id: e.id, source: e.source, target: e.target, ...(e.relay ? { relay: JSON.parse(e.relay) as CanvasRelay, hops: e.hops } : {}), ...(e.status ? { status: JSON.parse(e.status) as RelayStatus } : {}), ...(e.spec ? { spec: true } : {}) });
const edgesOf = (canvas: string) => db.prepare<[string], EdgeRow>("select id, source, target, relay, hops, status, spec from canvas_edges where canvas = ? order by created_at").all(canvas).map(toEdge);
// every card but a terminal fits its content until you size it yourself
const strip = ({ canvas: _, fit, archived, ...n }: NodeRow): CanvasNode => {
  const a = archived ? (JSON.parse(archived) as Archived) : undefined;
  const out: CanvasNode = n.kind === "term" ? n : { ...n, fit: fit !== 0 };
  return a ? { ...out, archived: { at: a.at, head: a.head } } : out;
};

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
const tidyEdges = () => {
  db.exec("delete from canvas_edges where source not in (select id from canvas_nodes where canvas = canvas_edges.canvas) or target not in (select id from canvas_nodes where canvas = canvas_edges.canvas)");
  db.exec("delete from canvas_relay_log where edge not in (select id from canvas_edges)");
};

export function listCanvases(): CanvasInfo[] {
  first();
  tidyEdges();
  // cards folded into a terminal that has since closed come back out
  for (const r of db.prepare<[], { head: string }>("select distinct json_extract(archived, '$.head') as head from canvas_nodes where archived is not null and json_extract(archived, '$.head') not in (select id from canvas_nodes)").all()) unarchive(r.head);
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
  db.prepare("delete from canvas_relay_log where edge in (select id from canvas_edges where canvas = ?)").run(id);
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

// A terminal put away without closing it: it keeps running, folded into a small card that says what it is, with the
// cards linked to it (its runs, changes, ticket, notes, a reviewer) folded into it too. They stay where they were,
// out of sight, and move with the archived card; unarchiving puts them all back.
export function archive(head: string, ids: string[]) {
  const h = nodeRow(head);
  if (h?.kind !== "term") throw new Error("Only a terminal can be archived");
  if (h.archived) throw new Error("It's archived already");
  const rows = [...new Set([head, ...ids])].map(nodeRow).filter((n): n is NodeRow => !!n && n.canvas === h.canvas && !n.archived);
  const at = Date.now();
  const set = db.prepare("update canvas_nodes set archived = ? where id = ?");
  db.transaction(() => {
    for (const n of rows) set.run(JSON.stringify(n.id === head ? { at, head, w: n.w, h: n.h } : { at, head }), n.id);
    db.prepare("update canvas_nodes set w = ?, h = ? where id = ?").run(ARCHIVED_W, ARCHIVED_H, head);
  })();
  return rows.map((n) => n.id);
}

export function unarchive(head: string) {
  const h = nodeRow(head);
  const a = h?.archived ? (JSON.parse(h.archived) as Archived) : undefined;
  db.transaction(() => {
    if (h && a?.head === head) db.prepare("update canvas_nodes set w = ?, h = ? where id = ?").run(a.w ?? TERM_W, a.h ?? TERM_H, head);
    db.prepare("update canvas_nodes set archived = null where json_extract(archived, '$.head') = ?").run(head);
  })();
  return !!h;
}

// Cards that go together (a terminal and all that's linked to it, say) onto a workspace in one go: laid out as they
// were, their middle at `at` (the middle of what another screen shows), or else clear of what's there. The lines
// between them go with them; lines to cards left behind don't. A note's file moves with it.
export function moveGroup(canvas: string, ids: string[], at?: At) {
  if (!canvasRow(canvas)) throw new Error("No such workspace");
  const rows = [...new Set(ids)].map(nodeRow).filter((n): n is NodeRow => !!n);
  if (!rows.length) throw new Error("None of those cards is on the canvas");
  const from = rows[0].canvas;
  if (rows.some((n) => n.canvas !== from)) throw new Error("Those cards aren't on one workspace");
  const left = Math.min(...rows.map((n) => n.x));
  const top = Math.min(...rows.map((n) => n.y));
  const w = Math.max(...rows.map((n) => n.x + n.w)) - left;
  const h = Math.max(...rows.map((n) => n.y + n.h)) - top;
  const moving = new Set(rows.map((n) => n.id));
  const spot = at
    ? { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2) }
    : freeSpot(
        rowsOf(canvas).filter((n) => !moving.has(n.id)),
        w,
        h,
      );
  const move = db.prepare("update canvas_nodes set canvas = ?, x = ?, y = ? where id = ?");
  db.transaction(() => {
    for (const n of rows) move.run(canvas, n.x - left + spot.x, n.y - top + spot.y, n.id);
    if (canvas !== from) {
      const list = [...moving];
      const marks = list.map(() => "?").join(",");
      db.prepare(`update canvas_edges set canvas = ? where canvas = ? and source in (${marks}) and target in (${marks})`).run(canvas, from, ...list, ...list);
    }
  })();
  if (canvas !== from)
    for (const n of rows.filter((r) => r.kind === "note")) {
      mkdirSync(notesDir(canvas), { recursive: true });
      try {
        renameSync(notePath(from, n.ref), notePath(canvas, n.ref));
      } catch {}
    }
  tidyEdges();
  return rowsOf(canvas)
    .filter((n) => moving.has(n.id))
    .map(strip);
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
function addPanel(kind: "changes" | "runs" | "plan", w: number, h: number, canvas: string, at?: At, link?: string) {
  if (!canvasRow(canvas)) throw new Error("No such workspace");
  const to = link ? nodeRow(link) : undefined;
  if (link && to?.canvas !== canvas) throw new Error("That card isn't on this workspace");
  const n = place(canvas, kind, randomUUID(), w, h, to ? { x: to.x, y: to.y + to.h + GAP } : at);
  return { node: n, edge: to ? addEdge(canvas, to.id, n.id) : undefined };
}
export const addChanges = (canvas: string, at?: At, link?: string) => addPanel("changes", CHANGES_W, CHANGES_H, canvas, at, link);
export const addRuns = (canvas: string, at?: At, link?: string) => addPanel("runs", RUNS_W, RUNS_H, canvas, at, link);
export const addPlan = (canvas: string, at?: At, link?: string) => addPanel("plan", PLAN_W, PLAN_H, canvas, at, link);

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
  db.prepare("delete from canvas_relay_log where edge in (select id from canvas_edges where source = ? or target = ?)").run(id, id);
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

export const removeEdge = (id: string) => {
  db.prepare("delete from canvas_relay_log where edge = ?").run(id);
  return db.prepare("delete from canvas_edges where id = ?").run(id).changes > 0;
};

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
    relay = { from: relay.from, role: relay.role, limit, ...(relay.role === "custom" ? { prompt: relay.prompt!.trim().slice(0, 2000) } : {}), ...(relay.when === "passing" || relay.when === "failing" ? { when: relay.when } : {}), ...(relay.role === "review" && relay.withDiff === false ? { withDiff: false } : {}), ...(relay.role === "review" ? panelOf(relay.panel) : {}) };
  }
  // set up again, it starts with nothing to report
  db.prepare("update canvas_edges set relay = ?, hops = 0, status = null where id = ?").run(relay ? JSON.stringify(relay) : null, id);
  return true;
}

const panelOf = (p: unknown) => (typeof p === "string" && /^[\w-]{1,40}$/.test(p.trim()) ? { panel: p.trim() } : {});

// a review line joins a panel, or leaves it (undefined), keeping its count
export function setPanel(id: string, panel: string | undefined) {
  const e = db.prepare<[string], { relay: string | null }>("select relay from canvas_edges where id = ?").get(id);
  const relay = e?.relay ? (JSON.parse(e.relay) as CanvasRelay) : undefined;
  if (relay?.role !== "review") throw new Error("Only a review line can review together with another");
  const { panel: _, ...rest } = relay;
  db.prepare("update canvas_edges set relay = ? where id = ?").run(JSON.stringify({ ...rest, ...panelOf(panel) }), id);
}

// The relays a finished turn in this terminal goes along: the terminal at the other end, and how
// the terminals at either end of a line between two of them
export function termEnds(edge: string) {
  const e = db.prepare<[string], { source: string; target: string }>("select source, target from canvas_edges where id = ?").get(edge);
  const s = e && nodeRow(e.source);
  const t = e && nodeRow(e.target);
  return s?.kind === "term" && t?.kind === "term" ? { source: s.ref, target: t.ref } : undefined;
}

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

export const edgeById = (id: string) => {
  const e = db.prepare<[string], EdgeRow>("select id, source, target, relay, hops, spec from canvas_edges where id = ?").get(id);
  return e && toEdge(e);
};
// a line's two cards, by card id
export const edgeCards = (edge: string) => db.prepare<[string], { source: string; target: string; canvas: string; hops: number }>("select source, target, canvas, hops from canvas_edges where id = ?").get(edge);
// the terminal on a terminal card
export const termOfCard = (card: string) => {
  const n = nodeRow(card);
  return n?.kind === "term" ? { term: n.ref, canvas: n.canvas } : undefined;
};

// A note made the spec of a terminal, or not: the line between them says so. Every relay line at that terminal then
// carries the note's text along with each turn.
export function setEdgeSpec(edge: string, on: boolean) {
  const e = db.prepare<[string], { source: string; target: string }>("select source, target from canvas_edges where id = ?").get(edge);
  if (!e) return false;
  const kinds = [nodeRow(e.source)?.kind, nodeRow(e.target)?.kind];
  if (on && !(kinds.includes("note") && kinds.includes("term"))) throw new Error("Only a line between a note and a terminal can make the note a spec");
  db.prepare("update canvas_edges set spec = ? where id = ?").run(on ? 1 : null, edge);
  return true;
}

// The terminals a note is the spec of, set all at once: a line is drawn to each that hasn't one, and the lines to
// terminals left out stay as plain lines
export function setSpec(note: string, cards: string[]) {
  const n = nodeRow(note);
  if (n?.kind !== "note") throw new Error("Only a note can be a spec");
  const want = new Set(cards);
  for (const c of want) {
    const t = nodeRow(c);
    if (t?.kind !== "term" || t.canvas !== n.canvas) throw new Error("A note can only be the spec of terminals on its own workspace");
  }
  db.transaction(() => {
    for (const c of want) setEdgeSpec(addEdge(n.canvas, note, c).id, true);
    for (const e of specEdges(note)) if (!want.has(e.card)) setEdgeSpec(e.edge, false);
  })();
  return specEdges(note);
}

// a note's spec lines: the terminal card at the other end, and its terminal
export function specEdges(note: string) {
  return db
    .prepare<[string, string], { id: string; source: string; target: string }>("select id, source, target from canvas_edges where spec = 1 and (source = ? or target = ?) order by created_at")
    .all(note, note)
    .flatMap((e) => {
      const card = e.source === note ? e.target : e.source;
      const t = nodeRow(card);
      return t?.kind === "term" ? [{ edge: e.id, card, term: t.ref }] : [];
    });
}

// The notes that are the spec of a relay line: those made the spec of either terminal at its ends, each once
export function specOfLine(edge: string) {
  const e = edgeCards(edge);
  if (!e) return [];
  const rows = db
    .prepare<[string, string, string, string], { source: string; target: string }>("select source, target from canvas_edges where spec = 1 and (source in (?, ?) or target in (?, ?)) order by created_at")
    .all(e.source, e.target, e.source, e.target);
  const notes = rows.map((r) => ([e.source, e.target].includes(r.source) ? r.target : r.source)).filter((id) => nodeRow(id)?.kind === "note");
  return [...new Set(notes)];
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
  // an archived card that moves takes the cards folded into it along, so they come back out around it
  const along = db.prepare("update canvas_nodes set x = x + ?, y = y + ? where json_extract(archived, '$.head') = ? and id != ?");
  db.transaction(() => {
    for (const n of nodes) {
      if (![n.x, n.y, n.w, n.h].every(Number.isFinite)) continue;
      const was = nodeRow(n.id);
      if (was?.archived && (JSON.parse(was.archived) as Archived).head === n.id && (was.x !== n.x || was.y !== n.y)) along.run(n.x - was.x, n.y - was.y, n.id, n.id);
      update.run(n.x, n.y, Math.max(160, n.w), Math.max(80, n.h), typeof n.fit === "boolean" ? Number(n.fit) : null, n.id, canvas);
    }
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
    placed.set(t.id, { ...n, canvas, fit: null, archived: null, node: t.node ?? "local" });
    changed = true;
  }
  if (changed) tidyEdges();
  return changed;
}

// What arranging needs to know of a terminal: the ticket it works on, whether it reviews, the terminal it was split
// from, and the repo or worktree it runs in (key, and a name to order by)
export type ArrangeTerm = { ticket?: string; review?: boolean; parent?: string; repo?: string; repoName?: string };
type Box = Pick<CanvasNode, "id" | "x" | "y" | "w" | "h">;
type ArrangeCard = Pick<CanvasNode, "id" | "kind" | "ref" | "w" | "h"> & { archived?: unknown };
export const BLOCK_GAP = 120;
const BLOCKS_PER_COLUMN = 3;
const byKey = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

// The tidy layout of a workspace: each ticket a block (its card top left, its workers to its right, its reviewers
// under them, a split shell beside the one it came from), the terminals with no ticket in a block for each repo or
// worktree, and the notes and other cards linked to a card in a block beside it. What's linked to nothing goes in a
// last block. The blocks go down a column of three and then on to the next column to the right, tickets by key and
// then repos by name. Archived cards
// stay where they are. Cards keep their size, but for a ticket's.
export function arrangeLayout(cards: ArrangeCard[], edges: Pick<CanvasEdge, "source" | "target">[], terms: Map<string, ArrangeTerm>): Box[] {
  const live = cards.filter((n) => !n.archived);
  const byId = new Map(live.map((n) => [n.id, n]));
  const termCard = new Map(live.filter((n) => n.kind === "term").map((n) => [n.ref, n]));
  const info = (n: ArrangeCard) => terms.get(n.ref) ?? {};
  // a split shell sits beside the terminal it came from, when that one is here too (the first of a chain)
  const rootOf = (n: ArrangeCard) => {
    const seen = new Set([n.id]);
    let at = n;
    for (let p = termCard.get(info(at).parent ?? ""); p && !seen.has(p.id); p = termCard.get(info(at).parent ?? "")) {
      seen.add(p.id);
      at = p;
    }
    return at;
  };
  const splits = new Map<string, ArrangeCard[]>();
  type Block = { order: [number, string]; ticket?: ArrangeCard; workers: ArrangeCard[]; reviewers: ArrangeCard[]; extras: ArrangeCard[] };
  const blocks = new Map<string, Block>();
  const block = (key: string, order: [number, string]) => blocks.get(key) ?? blocks.set(key, { order, workers: [], reviewers: [], extras: [] }).get(key)!;
  for (const n of live.filter((c) => c.kind === "ticket")) block(`ticket:${n.ref}`, [0, n.ref]).ticket = n;
  for (const n of live.filter((c) => c.kind === "term")) {
    const root = rootOf(n);
    if (root !== n) {
      splits.set(root.id, [...(splits.get(root.id) ?? []), n]);
      continue;
    }
    const t = info(n);
    const b = t.ticket ? block(`ticket:${t.ticket}`, [0, t.ticket]) : t.repo != null ? block(`repo:${t.repo}`, [1, t.repoName ?? t.repo]) : block("repo:?", [2, ""]);
    (t.review ? b.reviewers : b.workers).push(n);
  }
  const ordered = [...blocks.values()].sort((a, b) => a.order[0] - b.order[0] || byKey(a.order[1], b.order[1]));
  // notes and other cards follow the block of a card they're linked to, through other such cards too; anchor is the
  // card in the block they hang off
  const home = new Map<string, Block>();
  for (const b of ordered)
    for (const n of [b.ticket, ...b.workers, ...b.reviewers]) {
      if (!n) continue;
      for (const s of [n, ...(splits.get(n.id) ?? [])]) home.set(s.id, b);
    }
  const near = new Map<string, string[]>();
  for (const e of edges) {
    near.set(e.source, [...(near.get(e.source) ?? []), e.target]);
    near.set(e.target, [...(near.get(e.target) ?? []), e.source]);
  }
  const anchor = new Map<string, string>();
  const queue = [...home.keys()];
  while (queue.length) {
    const at = queue.shift()!;
    for (const id of near.get(at) ?? []) {
      const n = byId.get(id);
      if (!n || home.has(id) || n.kind === "term" || n.kind === "ticket") continue;
      home.set(id, home.get(at)!);
      anchor.set(id, anchor.get(at) ?? at);
      queue.push(id);
    }
  }
  const loose = live.filter((n) => n.kind !== "term" && n.kind !== "ticket");
  for (const n of loose) home.get(n.id)?.extras.push(n);
  const rest = loose.filter((n) => !home.has(n.id));

  // each block laid out from 0,0, then moved to its place in the grid
  const extent = (boxes: Box[]) => ({ boxes, w: Math.max(...boxes.map((p) => p.x + p.w)), h: Math.max(...boxes.map((p) => p.y + p.h)) });
  const laid: ReturnType<typeof extent>[] = [];
  for (const b of ordered) {
    const boxes: Box[] = [];
    const put = (n: ArrangeCard, x: number, y: number, w = n.w, h = n.h) => boxes.push({ id: n.id, x, y, w, h });
    if (b.ticket) put(b.ticket, 0, 0, TICKET_W, TICKET_H);
    const left = b.ticket ? TICKET_W + GAP : 0;
    let y = 0;
    for (const n of [...b.workers, ...b.reviewers]) {
      put(n, left, y);
      let x = left + n.w + GAP;
      let h = n.h;
      for (const s of splits.get(n.id) ?? []) {
        put(s, x, y);
        x += s.w + GAP;
        h = Math.max(h, s.h);
      }
      y += h + GAP;
    }
    // beside what each is linked to, in a column of their own past the rest
    const right = Math.max(...boxes.map((p) => p.x + p.w)) + GAP;
    const rowOf = (n: ArrangeCard) => boxes.find((p) => p.id === anchor.get(n.id))?.y ?? 0;
    let low = 0;
    for (const n of [...b.extras].sort((p, q) => rowOf(p) - rowOf(q))) {
      const y0 = Math.max(low, rowOf(n));
      put(n, right, y0);
      low = y0 + n.h + GAP;
    }
    laid.push(extent(boxes));
  }
  // what's linked to nothing, three to a row
  if (rest.length) {
    const boxes: Box[] = [];
    let y = 0;
    for (let i = 0; i < rest.length; i += 3) {
      const row = rest.slice(i, i + 3);
      let x = 0;
      for (const n of row) {
        boxes.push({ id: n.id, x, y, w: n.w, h: n.h });
        x += n.w + GAP;
      }
      y += Math.max(...row.map((n) => n.h)) + GAP;
    }
    laid.push(extent(boxes));
  }
  // down a column of three, then a new column to the right, as wide as its widest block
  const out: Box[] = [];
  let left = 0;
  for (let i = 0; i < laid.length; i += BLOCKS_PER_COLUMN) {
    const column = laid.slice(i, i + BLOCKS_PER_COLUMN);
    let y = 0;
    for (const b of column) {
      for (const p of b.boxes) out.push({ ...p, x: p.x + left, y: p.y + y });
      y += b.h + BLOCK_GAP;
    }
    left += Math.max(...column.map((b) => b.w)) + BLOCK_GAP;
  }
  return out;
}

const repoOfCwd = (t: TermInfo) => ({ key: `${t.node ?? "local"}:${t.cwd}`, name: t.cwd.split("/").filter(Boolean).pop() ?? t.cwd });

// A workspace tidied into that layout, saved in one go. A ticket whose terminals are here but whose card is on no
// workspace gets its card here; one on another workspace stays there, as nothing moves between workspaces.
export function arrange(
  canvas: string,
  terms: TermInfo[] = [],
  ticketOf: (t: TermInfo) => string | undefined = () => undefined,
  isReview: (t: TermInfo) => boolean = () => false,
  repoOf: (t: TermInfo) => { key: string; name: string } = repoOfCwd,
) {
  if (!canvasRow(canvas)) throw new Error("No such workspace");
  const byId = new Map(terms.map((t) => [t.id, t]));
  return db.transaction(() => {
    const info = new Map<string, ArrangeTerm>();
    for (const n of rowsOf(canvas)) {
      const t = n.kind === "term" ? byId.get(n.ref) : undefined;
      if (!t) continue;
      const repo = repoOf(t);
      info.set(n.ref, { ticket: ticketOf(t)?.trim().toUpperCase() || undefined, review: isReview(t), parent: t.parent, repo: repo.key, repoName: repo.name });
    }
    for (const key of new Set([...info.values()].flatMap((t) => (t.ticket ? [t.ticket] : [])))) if (!refRow("ticket", key)) place(canvas, "ticket", key, TICKET_W, TICKET_H);
    const boxes = arrangeLayout(
      rowsOf(canvas).map((r) => ({ id: r.id, kind: r.kind, ref: r.ref, w: r.w, h: r.h, archived: r.archived })),
      edgesOf(canvas),
      info,
    );
    saveLayout(canvas, boxes);
    return boxes;
  })();
}
