import { beforeEach, describe, expect, it } from "vitest";
import type { TermInfo } from "@cockpit/shared";
import { db } from "../src/db.ts";
import { addEdge, addNote, listCanvases, placeTicket, setRelay, syncTerms } from "../src/canvas.ts";
import { canvasView, findCard, openBeside, type BesideDeps, type FindCtx } from "../src/canvasTools.ts";

const term = (id: string, more: Partial<TermInfo> = {}): TermInfo => ({ id, title: id, cwd: "/tmp", command: "bash", createdAt: 0, node: "local", ...more });
const WT = "/repo/.worktrees/acme-123";

let terms: TermInfo[];
const ctx = (more: Partial<FindCtx> = {}): FindCtx => ({ canvases: listCanvases(), terms, tasks: [], sessions: [], ...more });
const cardOf = (ref: string) => listCanvases()[0].nodes.find((n) => n.ref === ref)!;

beforeEach(() => {
  db.exec("delete from canvas_nodes; delete from canvas_edges; delete from canvases;");
  terms = [
    term("shell", { cwd: WT, createdAt: 1 }),
    term("worker", { cwd: `${WT}/app`, command: "claude --model opus", session: "sess-1", createdAt: 2, title: "claude · acme-123" }),
    term("reviewer", { cwd: WT, command: "codex", session: "sess-2", createdAt: 3, title: "Codex review · acme-123" }),
  ];
  syncTerms(terms);
});

describe("finding a worker's card", () => {
  it("takes a card id, a terminal id or a session, bare or as the Board names it", () => {
    const card = cardOf("worker");
    expect(findCard(card.id, ctx()).node.id).toBe(card.id);
    expect(findCard("worker", ctx()).node.id).toBe(card.id);
    expect(findCard("sess-1", ctx()).node.id).toBe(card.id);
    expect(findCard("s:sess-1", ctx()).node.id).toBe(card.id);
    // a session only the sessions list ties to its terminal
    expect(findCard("sess-9", ctx({ sessions: [{ id: "sess-9", term: "reviewer" }] })).node.ref).toBe("reviewer");
  });

  it("picks the worker's agent out of a worktree's terminals, not its shell or its reviewer", () => {
    expect(findCard(WT, ctx()).node.ref).toBe("worker");
    expect(findCard(`${WT}/`, ctx()).node.ref).toBe("worker");
  });

  it("follows a task to its terminal, its session or its worktree", () => {
    expect(findCard("t:task-1", ctx({ tasks: [{ id: "task-1", group: "g1", termId: "gone", sessionId: "sess-1" }] })).node.ref).toBe("worker");
    expect(findCard("task-2", ctx({ tasks: [{ id: "task-2", group: "g2", worktree: WT }] })).node.ref).toBe("worker");
    expect(findCard("g2", ctx({ tasks: [{ id: "task-2", group: "g2", worktree: WT }] })).node.ref).toBe("worker");
    const two = ctx({ tasks: [{ id: "a", group: "g", worktree: WT }, { id: "b", group: "g", worktree: "/elsewhere" }] });
    expect(() => findCard("g", two)).toThrow(/group of 2 attempts: name one of its tasks \(a, b\)/);
    expect(() => findCard("b", two)).toThrow(/Task b has no terminal open in \/elsewhere/);
  });

  it("finds a ticket's card by its key", () => {
    placeTicket(listCanvases()[0].id, "ACME-7");
    expect(findCard("acme-7", ctx()).node.kind).toBe("ticket");
  });

  it("says what it takes when nothing matches", () => {
    expect(() => findCard("nope", ctx())).toThrow(/Nothing on the canvas matches "nope"/);
    expect(() => findCard(" ", ctx())).toThrow(/Say which worker/);
  });
});

describe("the lead's view of the canvas", () => {
  it("names each card and says what each line does", () => {
    const ws = listCanvases()[0];
    const worker = cardOf("worker");
    const reviewer = cardOf("reviewer");
    const note = addNote(ws.id, undefined, "Watch the migration");
    const line = addEdge(ws.id, worker.id, reviewer.id);
    setRelay(line.id, { from: "both", role: "review", limit: 2, when: "passing" });
    addEdge(ws.id, worker.id, note.id);
    const [view] = canvasView(listCanvases(), terms);
    expect(view.cards.find((c) => c.id === worker.id)).toMatchObject({ kind: "term", title: "claude · acme-123", session: "sess-1", state: "running" });
    expect(view.cards.find((c) => c.id === note.id)).toMatchObject({ kind: "note", text: "Watch the migration" });
    expect(view.lines[0]).toMatchObject({ id: line.id, role: "review", goes: "both ways", when: "passing", hops: "0 of 2", withDiff: true, between: "claude · acme-123 → Codex review · acme-123" });
    expect(view.lines[1]).toMatchObject({ role: "plain line" });
    expect(canvasView(listCanvases(), terms, undefined, "nowhere")).toEqual([]);
  });
});

describe("opening Codex or the local model beside a worker", () => {
  const deps = (more: Partial<BesideDeps> = {}): BesideDeps & { spawned: Parameters<BesideDeps["spawn"]>[0][] } => {
    const spawned: Parameters<BesideDeps["spawn"]>[0][] = [];
    return {
      quick: { model: "qwen2.5-coder:7b", url: "http://127.0.0.1:11434" },
      base: "main",
      cwdNow: () => undefined,
      spawn: async (o) => {
        spawned.push(o);
        return { id: "made" };
      },
      spawned,
      ...more,
    };
  };

  it("opens a reviewer in the worker's folder, beside it, on a review line both ways", async () => {
    const d = deps();
    const made = await openBeside(findCard("worker", ctx()), "codex", "reviewer", d);
    expect(d.spawned[0]).toMatchObject({ cwd: `${WT}/app`, command: "codex", args: [], title: "Codex review · app" });
    const ws = listCanvases()[0];
    const worker = cardOf("worker");
    // along the worker's row, past the reviewer already beside it
    const card = ws.nodes.find((n) => n.id === made.card)!;
    expect(card).toMatchObject({ ref: "made", y: worker.y });
    expect(card.x).toBeGreaterThan(worker.x + worker.w);
    expect(ws.edges.find((e) => e.id === made.line)).toMatchObject({ source: worker.id, relay: { from: "both", role: "review", limit: 4 } });
  });

  it("opens a one-off review of the changes read-only, on a plain line", async () => {
    const d = deps({ cwdNow: () => "/moved/here" });
    const made = await openBeside(findCard("worker", ctx()), "local", "review", d);
    expect(d.spawned[0]).toMatchObject({ cwd: "/moved/here", command: "cockpit:chat", args: ["--model", "qwen2.5-coder:7b", "--url", "http://127.0.0.1:11434", "--review", "--base", "main"] });
    expect(listCanvases()[0].edges.find((e) => e.id === made.line)?.relay).toBeUndefined();
  });

  it("falls back to the folder the terminal started in", async () => {
    const d = deps({ cwdNow: () => "/not/allowed", spawn: async (o) => (o.cwd === "/not/allowed" ? Promise.reject(new Error("no")) : { id: "made" }) });
    await expect(openBeside(findCard("worker", ctx()), "codex", "chat", d)).resolves.toMatchObject({ terminal: "made" });
  });

  it("says why it can't", async () => {
    await expect(openBeside(findCard("worker", ctx()), "local", "chat", deps({ quick: {} }))).rejects.toThrow(/No local model yet/);
    placeTicket(listCanvases()[0].id, "ACME-7");
    await expect(openBeside(findCard("ACME-7", ctx()), "codex", "chat", deps())).rejects.toThrow(/ticket card, not a terminal/);
    terms[1] = { ...terms[1], exited: 0 };
    await expect(openBeside(findCard("worker", ctx()), "codex", "chat", deps())).rejects.toThrow(/has exited/);
  });
});
