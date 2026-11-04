import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { TermInfo } from "@cockpit/shared";
import { paths } from "../src/config.ts";
import { db } from "../src/db.ts";
import { addNote, createCanvas, deleteCanvas, freeSpot, listCanvases, placeTerm, readNote, removeNode, renameCanvas, saveLayout, syncTerms, TERM_H, TERM_W, writeNote } from "../src/canvas.ts";

const term = (id: string, more: Partial<TermInfo> = {}): TermInfo => ({ id, title: id, cwd: "/tmp", command: "bash", createdAt: 0, node: "local", ...more });
const onCanvas = (name: string) => listCanvases().find((c) => c.name === name)!;

beforeEach(() => {
  db.exec("delete from canvas_nodes; delete from canvases;");
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
