import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { TermInfo } from "@cockpit/shared";
import { paths } from "../src/config.ts";
import { db } from "../src/db.ts";
import { addEdge, addNote, createCanvas, deleteCanvas, freeSpot, listCanvases, placeTerm, placeTicket, readNote, rekeyTerms, removeEdge, removeNode, renameCanvas, saveLayout, syncTerms, TERM_H, TERM_W, ticketCard, writeNote } from "../src/canvas.ts";
import { ticketOfTerm } from "../src/routes/canvas.ts";

const term = (id: string, more: Partial<TermInfo> = {}): TermInfo => ({ id, title: id, cwd: "/tmp", command: "bash", createdAt: 0, node: "local", ...more });
const onCanvas = (name: string) => listCanvases().find((c) => c.name === name)!;

beforeEach(() => {
  db.exec("delete from canvas_nodes; delete from canvas_edges; delete from canvases;");
  listCanvases();
});

describe("workspaces", () => {
  it("always has one to land on", () => {
    expect(listCanvases().map((c) => c.name)).toEqual(["Main"]);
  });

  it("creates, renames and won't delete the last one", () => {
    const main = listCanvases()[0];
    const b = createCanvas("Review");
    expect(renameCanvas(b.id, "  Reviews ")).toBe(true);
    expect(listCanvases().map((c) => c.name)).toEqual(["Main", "Reviews"]);
    expect(() => renameCanvas(b.id, " ")).toThrow();
    expect(deleteCanvas(b.id)).toBe(true);
    expect(() => deleteCanvas(main.id)).toThrow(/last workspace/);
  });

  it("moves a deleted workspace's terminals to the first one and drops its notes", () => {
    syncTerms([term("a")]);
    const b = createCanvas("Side");
    placeTerm(b.id, "a");
    const note = addNote(b.id);
    const file = join(paths.data, "canvas", b.id, note.ref);
    expect(existsSync(file)).toBe(true);
    deleteCanvas(b.id);
    expect(onCanvas("Main").nodes.map((n) => n.ref)).toEqual(["a"]);
    expect(existsSync(file)).toBe(false);
  });
});

describe("terminals", () => {
  it("joins new terminals to the first workspace without overlapping", () => {
    expect(syncTerms([term("a"), term("b"), term("c"), term("d")])).toBe(true);
    const nodes = onCanvas("Main").nodes;
    expect(nodes.map((n) => [n.x, n.y])).toEqual([
      [0, 0],
      [TERM_W + 40, 0],
      [2 * (TERM_W + 40), 0],
      [0, TERM_H + 40],
    ]);
    expect(syncTerms([term("a"), term("b"), term("c"), term("d")])).toBe(false);
  });

  it("puts a split shell next to the terminal it came from, on that terminal's workspace", () => {
    syncTerms([term("a")]);
    const b = createCanvas("Side");
    placeTerm(b.id, "a", { x: 100, y: 200 });
    syncTerms([term("a"), term("split", { parent: "a" })]);
    const nodes = onCanvas("Side").nodes;
    expect(nodes.find((n) => n.ref === "split")).toMatchObject({ x: 100 + TERM_W + 40, y: 200 });
  });

  it("keeps a terminal on one workspace at a time, with its size", () => {
    syncTerms([term("a")]);
    const main = onCanvas("Main");
    saveLayout(main.id, [{ id: main.nodes[0].id, x: 5, y: 6, w: 900, h: 500 }]);
    const b = createCanvas("Side");
    placeTerm(b.id, "a", { x: 0, y: 0 });
    expect(onCanvas("Main").nodes).toEqual([]);
    expect(onCanvas("Side").nodes[0]).toMatchObject({ ref: "a", w: 900, h: 500 });
  });

  it("drops closed terminals, but not those of a node that isn't listing any", () => {
    syncTerms([term("a"), term("far", { node: "linux" })]);
    // the node's link is down: its terminal is missing from the list but still runs
    expect(syncTerms([term("a")])).toBe(false);
    expect(onCanvas("Main").nodes.map((n) => n.ref).sort()).toEqual(["a", "far"]);
    // the node lists again, without it: it was closed
    syncTerms([term("a"), term("other", { node: "linux" })]);
    expect(onCanvas("Main").nodes.map((n) => n.ref).sort()).toEqual(["a", "other"]);
    syncTerms([term("other", { node: "linux" })]);
    expect(onCanvas("Main").nodes.map((n) => n.ref)).toEqual(["other"]);
  });
});

describe("tickets and lines", () => {
  it("keeps a ticket on one workspace at a time, by its key", () => {
    const main = listCanvases()[0];
    const card = placeTicket(main.id, " acme-12 ");
    expect(card).toMatchObject({ kind: "ticket", ref: "ACME-12" });
    expect(ticketCard("ACME-12")).toMatchObject({ id: card.id, canvas: main.id });
    const side = createCanvas("Side");
    placeTicket(side.id, "ACME-12");
    expect(onCanvas("Main").nodes).toEqual([]);
    expect(onCanvas("Side").nodes.map((n) => n.ref)).toEqual(["ACME-12"]);
  });

  it("starts a terminal in a ticket's worktree beside that ticket's card", () => {
    const side = createCanvas("Side");
    const card = placeTicket(side.id, "ACME-12", { x: 100, y: 100 });
    syncTerms([term("plain"), term("work", { cwd: "/wt/ACME-12/repo/app" })], ticketOfTerm([{ path: "/wt/ACME-12/repo", name: "ACME-12", head: "", main: false, ticket: "ACME-12" }]));
    expect(onCanvas("Side").nodes.find((n) => n.ref === "work")).toMatchObject({ x: card.x + card.w + 40, y: card.y });
    expect(onCanvas("Main").nodes.map((n) => n.ref)).toEqual(["plain"]);
  });

  it("matches a worktree only on the machine it's on", () => {
    const of = ticketOfTerm([{ path: "/wt/A-1/repo", name: "A-1", head: "", main: false, ticket: "A-1", node: "linux" }]);
    expect(of(term("x", { cwd: "/wt/A-1/repo" }))).toBeUndefined();
    expect(of(term("x", { cwd: "/wt/A-1/repo", node: "linux" }))).toBe("A-1");
    expect(of(term("x", { cwd: "/wt/A-1/repository", node: "linux" }))).toBeUndefined();
  });

  it("links two cards once, on the same workspace only", () => {
    syncTerms([term("a"), term("b")]);
    const main = onCanvas("Main");
    const [a, b] = main.nodes;
    const e = addEdge(main.id, a.id, b.id);
    expect(addEdge(main.id, b.id, a.id).id).toBe(e.id);
    expect(() => addEdge(main.id, a.id, a.id)).toThrow();
    const side = createCanvas("Side");
    expect(() => addEdge(side.id, a.id, b.id)).toThrow(/this workspace/);
    expect(onCanvas("Main").edges).toEqual([e]);
    expect(removeEdge(e.id)).toBe(true);
    expect(onCanvas("Main").edges).toEqual([]);
  });

  it("drops a line when one of its cards leaves the workspace", () => {
    syncTerms([term("a"), term("b")]);
    const main = onCanvas("Main");
    const t = placeTicket(main.id, "ACME-1");
    addEdge(main.id, main.nodes[0].id, t.id);
    addEdge(main.id, main.nodes[1].id, t.id);
    // a moves away, b closes
    placeTerm(createCanvas("Side").id, "a");
    syncTerms([term("a")]);
    expect(onCanvas("Main").edges).toEqual([]);
  });

  it("sends a deleted workspace's tickets to the first one too", () => {
    const side = createCanvas("Side");
    placeTicket(side.id, "ACME-7");
    deleteCanvas(side.id);
    expect(onCanvas("Main").nodes.map((n) => n.ref)).toEqual(["ACME-7"]);
  });
});

describe("after a reboot", () => {
  it("hands a card to the terminal reopened in its place, where it was", () => {
    syncTerms([term("old"), term("shell")]);
    const main = onCanvas("Main");
    const card = main.nodes.find((n) => n.ref === "old")!;
    saveLayout(main.id, [{ id: card.id, x: 1234, y: 567, w: 800, h: 500 }]);
    rekeyTerms(new Map([["old", "new"]]));
    expect(syncTerms([term("new"), term("shell")])).toBe(false);
    expect(onCanvas("Main").nodes.find((n) => n.id === card.id)).toMatchObject({ ref: "new", x: 1234, y: 567, w: 800, h: 500 });
  });
});

describe("notes and layout", () => {
  it("keeps a note as a markdown file", () => {
    const main = listCanvases()[0];
    const n = addNote(main.id, { x: 10, y: 20 }, "# hi");
    expect(n).toMatchObject({ kind: "note", x: 10, y: 20 });
    expect(n.ref).toMatch(/\.md$/);
    expect(readNote(n.id)).toBe("# hi");
    expect(writeNote(n.id, "- one\n- two")).toBe(true);
    expect(readNote(n.id)).toBe("- one\n- two");
    expect(removeNode(n.id)).toBe(true);
    expect(readNote(n.id)).toBeUndefined();
  });

  it("saves only sane sizes, and only for that workspace's cards", () => {
    syncTerms([term("a")]);
    const main = onCanvas("Main");
    const other = createCanvas("Other");
    const id = main.nodes[0].id;
    saveLayout(other.id, [{ id, x: 999, y: 999, w: 999, h: 999 }]);
    saveLayout(main.id, [{ id, x: 1, y: 2, w: 10, h: Number.NaN }]);
    expect(onCanvas("Main").nodes[0]).toMatchObject({ x: 0, y: 0 });
    saveLayout(main.id, [{ id, x: 1, y: 2, w: 10, h: 20 }]);
    expect(onCanvas("Main").nodes[0]).toMatchObject({ x: 1, y: 2, w: 160, h: 120 });
  });

  it("doesn't drop a new card on top of another", () => {
    const main = listCanvases()[0];
    addNote(main.id, { x: 0, y: 0 });
    expect(addNote(main.id, { x: 10, y: 10 })).toMatchObject({ x: 10 + 320 + 40, y: 10 });
  });

  it("finds a free spot beside a card", () => {
    const nodes = [{ x: 0, y: 0, w: 300, h: 200 }];
    expect(freeSpot(nodes, 300, 200, { x: 0, y: 0 })).toEqual({ x: 340, y: 0 });
  });
});
