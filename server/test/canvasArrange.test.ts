import { beforeEach, describe, expect, it } from "vitest";
import type { CanvasNode, TermInfo } from "@cockpit/shared";
import { db } from "../src/db.ts";
import { addEdge, addNote, arrange, arrangeLayout, BLOCK_GAP, createCanvas, listCanvases, placeTerm, placeTicket, reviewersOn, setRelay, syncTerms, TERM_H, TERM_W, TICKET_H, TICKET_W, type ArrangeTerm } from "../src/canvas.ts";

const GAP = 40;
type Card = Pick<CanvasNode, "id" | "kind" | "ref" | "w" | "h"> & { archived?: unknown };
const card = (id: string, kind: CanvasNode["kind"], more: Partial<Card> = {}): Card => {
  const size = { term: [TERM_W, TERM_H], ticket: [TICKET_W, TICKET_H], note: [320, 260] } as Record<string, [number, number]>;
  const [w, h] = size[kind] ?? [440, 320];
  return { id, kind, ref: id, w, h, ...more };
};
const at = (boxes: { id: string; x: number; y: number }[], id: string) => {
  const b = boxes.find((p) => p.id === id);
  return b && { x: b.x, y: b.y };
};

describe("arrangeLayout", () => {
  it("puts a ticket's worker to its right and its reviewer beside the worker", () => {
    const cards = [card("rev", "term"), card("ACME-1", "ticket", { w: 500, h: 400 }), card("work", "term")];
    const terms = new Map<string, ArrangeTerm>([
      ["work", { ticket: "ACME-1", repo: "r" }],
      ["rev", { ticket: "ACME-1", review: true, repo: "r" }],
    ]);
    const out = arrangeLayout(cards, [], terms);
    expect(out.find((b) => b.id === "ACME-1")).toEqual({ id: "ACME-1", x: 0, y: 0, w: TICKET_W, h: TICKET_H });
    expect(at(out, "work")).toEqual({ x: TICKET_W + GAP, y: 0 });
    expect(at(out, "rev")).toEqual({ x: TICKET_W + GAP + TERM_W + GAP, y: 0 });
  });

  it("makes a block without the ticket card when it isn't here, with its workers side by side, three to a row", () => {
    const terms = new Map<string, ArrangeTerm>(["a", "b", "c", "d"].map((id) => [id, { ticket: "ACME-2" }]));
    const out = arrangeLayout(["a", "b", "c", "d"].map((id) => card(id, "term")), [], terms);
    expect(at(out, "a")).toEqual({ x: 0, y: 0 });
    expect(at(out, "b")).toEqual({ x: TERM_W + GAP, y: 0 });
    expect(at(out, "c")).toEqual({ x: 2 * (TERM_W + GAP), y: 0 });
    expect(at(out, "d")).toEqual({ x: 0, y: TERM_H + GAP });
  });

  it("groups terminals with no ticket by repo, worker first, its split right after it, then the reviewer", () => {
    const terms = new Map<string, ArrangeTerm>([
      ["w1", { repo: "local:/x/beta", repoName: "beta" }],
      ["r1", { repo: "local:/x/beta", repoName: "beta", review: true }],
      ["s1", { repo: "local:/x/beta/sub", repoName: "sub", parent: "w1" }],
      ["w2", { repo: "local:/x/alpha", repoName: "alpha" }],
    ]);
    const out = arrangeLayout([card("w1", "term"), card("r1", "term"), card("s1", "term"), card("w2", "term")], [], terms);
    // alpha before beta
    expect(at(out, "w2")).toEqual({ x: 0, y: 0 });
    const beta = TERM_H + BLOCK_GAP;
    expect(at(out, "w1")).toEqual({ x: 0, y: beta });
    expect(at(out, "s1")).toEqual({ x: TERM_W + GAP, y: beta });
    expect(at(out, "r1")).toEqual({ x: 2 * (TERM_W + GAP), y: beta });
  });

  it("orders tickets by key, numbers as numbers, before repos", () => {
    const terms = new Map<string, ArrangeTerm>([
      ["repo", { repo: "local:/a", repoName: "a" }],
      ["t10", { ticket: "ACME-10" }],
      ["t9", { ticket: "ACME-9" }],
    ]);
    const out = arrangeLayout([card("repo", "term"), card("t10", "term"), card("t9", "term")], [], terms, 100);
    expect([out.find((b) => b.id === "t9")!.x, out.find((b) => b.id === "t10")!.x, out.find((b) => b.id === "repo")!.x]).toEqual([0, TERM_W + BLOCK_GAP, 2 * (TERM_W + BLOCK_GAP)]);
  });

  it("moves a linked note with its block, beside the card it's linked to, and the unlinked ones to a last block", () => {
    const terms = new Map<string, ArrangeTerm>([
      ["work", { ticket: "ACME-1" }],
      ["rev", { ticket: "ACME-1", review: true }],
    ]);
    const cards = [card("ACME-1", "ticket"), card("work", "term"), card("rev", "term"), card("spec", "note"), card("runs", "runs"), card("loose", "note")];
    // spec hangs off the reviewer; runs hangs off spec, so it follows too
    const out = arrangeLayout(cards, [{ source: "spec", target: "rev" }, { source: "runs", target: "spec" }], terms);
    const right = TICKET_W + GAP + 2 * (TERM_W + GAP);
    expect(at(out, "spec")).toEqual({ x: right, y: 0 });
    expect(at(out, "runs")).toEqual({ x: right, y: 260 + GAP });
    // the block is as tall as its lowest card, the runs card (320 high)
    expect(at(out, "loose")).toEqual({ x: 0, y: 260 + GAP + 320 + BLOCK_GAP });
  });

  it("puts blocks left to right and wraps to a new row when the row is as wide as the screen's shape allows", () => {
    const terms = new Map<string, ArrangeTerm>([
      ["a", { ticket: "ACME-1" }],
      ["b", { ticket: "ACME-2" }],
      ["b2", { ticket: "ACME-2" }],
      ["c", { ticket: "ACME-3" }],
      ["d", { ticket: "ACME-4" }],
    ]);
    const cards = ["a", "b", "b2", "c", "d"].map((id) => card(id, "term"));
    // a very wide screen: one row
    const wide = arrangeLayout(cards, [], terms, 100);
    expect(at(wide, "a")).toEqual({ x: 0, y: 0 });
    expect(at(wide, "b")).toEqual({ x: TERM_W + BLOCK_GAP, y: 0 });
    expect(at(wide, "c")).toEqual({ x: TERM_W + BLOCK_GAP + 2 * TERM_W + GAP + BLOCK_GAP, y: 0 });
    // a very tall one: no row wider than the widest block (b with b2), so each block on a row of its own
    const tall = arrangeLayout(cards, [], terms, 0.1);
    expect(at(tall, "b")).toEqual({ x: 0, y: TERM_H + BLOCK_GAP });
    expect(at(tall, "d")).toEqual({ x: 0, y: 3 * (TERM_H + BLOCK_GAP) });
    // a screen's shape: two rows, filled left to right
    const screen = arrangeLayout(cards, [], terms, 16 / 9);
    expect(at(screen, "a")).toEqual({ x: 0, y: 0 });
    expect(at(screen, "b")!.y).toBe(0);
    expect(at(screen, "d")!.y).toBeGreaterThan(0);
  });

  it("leaves archived cards out", () => {
    const out = arrangeLayout([card("a", "term"), card("gone", "note", { archived: { at: 1, head: "a" } })], [], new Map());
    expect(out.map((b) => b.id)).toEqual(["a"]);
  });
});

describe("arrange", () => {
  const term = (id: string, more: Partial<TermInfo> = {}): TermInfo => ({ id, title: id, cwd: "/tmp", command: "bash", createdAt: 0, node: "local", ...more });
  beforeEach(() => {
    db.exec("delete from canvas_nodes; delete from canvas_edges; delete from canvases;");
    listCanvases();
  });

  it("saves the layout of one workspace, making a missing ticket card and leaving others alone", () => {
    const terms = [term("w", { cwd: "/wt/ACME-7" }), term("r", { cwd: "/wt/ACME-7", title: "review #3" }), term("x")];
    syncTerms(terms);
    const here = createCanvas("Here");
    const there = createCanvas("There");
    placeTerm(here.id, "w");
    placeTerm(here.id, "r");
    placeTerm(there.id, "x");
    const note = addNote(here.id);
    const wCard = listCanvases().find((c) => c.id === here.id)!.nodes.find((n) => n.ref === "w")!;
    addEdge(here.id, wCard.id, note.id);
    const before = listCanvases().find((c) => c.id === there.id)!.nodes;

    arrange(here.id, terms, (t) => (t.cwd === "/wt/ACME-7" ? "acme-7" : undefined), (t) => t.title.startsWith("review"));

    const ws = listCanvases().find((c) => c.id === here.id)!;
    const pos = (ref: string) => ws.nodes.find((n) => n.ref === ref)!;
    expect(pos("ACME-7")).toMatchObject({ kind: "ticket", x: 0, y: 0 });
    expect(pos("w")).toMatchObject({ x: TICKET_W + GAP, y: 0 });
    expect(pos("r")).toMatchObject({ x: TICKET_W + GAP + TERM_W + GAP, y: 0 });
    expect(pos(note.ref)).toMatchObject({ x: TICKET_W + GAP + 2 * (TERM_W + GAP), y: 0 });
    expect(listCanvases().find((c) => c.id === there.id)!.nodes).toEqual(before);
  });

  it("doesn't take a ticket card from another workspace", () => {
    const terms = [term("w", { cwd: "/wt/ACME-8" })];
    syncTerms(terms);
    const here = createCanvas("Here");
    const there = createCanvas("There");
    placeTerm(here.id, "w");
    placeTicket(there.id, "ACME-8");
    arrange(here.id, terms, () => "ACME-8");
    expect(listCanvases().find((c) => c.id === here.id)!.nodes.map((n) => n.kind)).toEqual(["term"]);
    expect(listCanvases().find((c) => c.id === there.id)!.nodes.map((n) => n.ref)).toEqual(["ACME-8"]);
  });
});

describe("reviewersOn", () => {
  const term = (id: string): TermInfo => ({ id, title: id, cwd: "/tmp", command: "bash", createdAt: 0, node: "local" });
  beforeEach(() => db.exec("delete from canvas_nodes; delete from canvas_edges; delete from canvases;"));

  it("names the end a review line hands turns to, the target when it goes both ways, and skips other roles", () => {
    syncTerms(["a", "b", "c", "d"].map(term));
    const ws = createCanvas("Here");
    const card = (id: string) => placeTerm(ws.id, id);
    const [a, b, c, d] = ["a", "b", "c", "d"].map(card);
    setRelay(addEdge(ws.id, a.id, b.id).id, { from: "both", role: "review", limit: 4 });
    setRelay(addEdge(ws.id, c.id, a.id).id, { from: "target", role: "review", limit: 4 });
    setRelay(addEdge(ws.id, a.id, d.id).id, { from: "source", role: "build", limit: 4 });
    expect([...reviewersOn(ws.id)].sort()).toEqual(["b", "c"]);
  });
});
