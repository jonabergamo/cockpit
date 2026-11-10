import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, TermInfo } from "@cockpit/shared";

const sent: { id: string; text: string }[] = [];
// what each terminal's agent said last
const said = new Map<string, string>();
vi.mock("../src/agents.ts", () => ({
  lastWords: async (id: string) => ({ text: said.get(id) ?? "Added the export button and its test." }),
  sendText: async (id: string, text: string) => (sent.push({ id, text }), true),
}));
vi.mock("../src/runs.ts", () => ({ listRuns: () => [], settledFail: () => false }));
vi.mock("../src/remote/sessions.ts", () => ({ onNode: (_id: string, _remote: unknown, local: () => unknown) => Promise.resolve(local()) }));
vi.mock("../src/quick.ts", async (orig) => ({ ...(await orig<typeof import("../src/quick.ts")>()), quick: async () => undefined }));
vi.mock("../src/pty.ts", async (orig) => ({ ...(await orig<typeof import("../src/pty.ts")>()), listTerms: () => [], typeInto: () => {} }));

const { db } = await import("../src/db.ts");
const canvas = await import("../src/canvas.ts");
const { broadcast } = await import("../src/hub.ts");
const { joinPanel, panelWait, relayMessage, replay, sendSpec, SPEC_MAX, specSection, startRelays, withSpec } = await import("../src/relay.ts");

const term = (id: string): TermInfo => ({ id, title: id, cwd: "/tmp", command: "claude", createdAt: 0, node: "local" });
const session = (id: string, termId: string, status: Session["status"]): Session => ({ id, project: "p", cwd: "/tmp", status, startedAt: 0, updatedAt: 0, size: 0, term: termId, title: `${id} title` });
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const turn = async (who: string, termId: string) => {
  broadcast({ type: "sessions", sessions: [session(who, termId, "busy")] });
  broadcast({ type: "sessions", sessions: [session(who, termId, "idle")] });
  await settle();
};
const SPEC = "# Export\n\nThe CSV export has a header row and quotes every field.";

describe("a spec's part in a relayed message", () => {
  const review = { from: "both" as const, role: "review" as const, limit: 3 };

  it("goes under its heading, before the footer, and a reviewer judges the change against it", () => {
    const spec = specSection([SPEC], true);
    expect(spec).toMatch(/^The spec you both work to:\n\n# Export/);
    expect(spec).toContain("Judge the change against this spec; call out anything it misses or contradicts.");
    const m = relayMessage("Builder", "Added the export.", review, 1, false, "```diff\n+x\n```", spec);
    expect(m.indexOf("Review this work")).toBeLessThan(m.indexOf("The spec you both work to:"));
    expect(m.indexOf("```diff")).toBeLessThan(m.indexOf("The spec you both work to:"));
    expect(m.trimEnd().endsWith("(Passed on by cockpit's canvas, 1 of 3.)")).toBe(true);
  });

  it("asks no judging on a line that doesn't review, and leaves a message alone when there's no spec", () => {
    expect(specSection([SPEC])).not.toContain("Judge");
    expect(specSection(["  ", ""])).toBe("");
    const plain = relayMessage("Builder", "Done.", { from: "source", role: "build", limit: 3 }, 1);
    expect(withSpec(plain, "")).toBe(plain);
    expect(withSpec("no footer here", "The spec you both work to:\n\nx")).toBe("no footer here\n\nThe spec you both work to:\n\nx");
  });

  it("joins several notes, and cuts a long spec short saying so", () => {
    expect(specSection(["one", "two"])).toContain("one\n\n---\n\ntwo");
    const long = specSection(["x".repeat(SPEC_MAX + 500)]);
    expect(long).toContain("x".repeat(SPEC_MAX));
    expect(long).not.toContain("x".repeat(SPEC_MAX + 1));
    expect(long).toContain("cut short here at 8k characters");
  });
});

describe("a note as the spec of relay lines", () => {
  beforeAll(() => startRelays());
  let cards: Record<string, string> = {};
  let note = "";
  let ws = "";
  beforeEach(() => {
    db.exec("delete from canvas_nodes; delete from canvas_edges; delete from canvases; delete from canvas_relay_log;");
    sent.length = 0;
    said.clear();
    panelWait.ms = () => 60_000;
    canvas.syncTerms([term("builder"), term("reviewer"), term("tester")]);
    const main = canvas.listCanvases()[0];
    ws = main.id;
    cards = Object.fromEntries(main.nodes.map((n) => [n.ref, n.id]));
    note = canvas.addNote(ws, undefined, SPEC).id;
    broadcast({ type: "sessions", sessions: [session("bld", "builder", "idle"), session("rev", "reviewer", "idle"), session("tst", "tester", "idle")] });
  });
  const reviewLine = () => {
    const l = canvas.addEdge(ws, cards.builder, cards.reviewer).id;
    canvas.setRelay(l, { from: "both", role: "review", limit: 4 });
    return l;
  };

  it("is set on terminals only, draws the lines it needs, and lets go of the ones left out", () => {
    const ends = canvas.setSpec(note, [cards.builder, cards.tester]);
    expect(ends.map((e) => e.term).sort()).toEqual(["builder", "tester"]);
    expect(canvas.listCanvases()[0].edges.filter((e) => e.spec)).toHaveLength(2);
    canvas.setSpec(note, [cards.builder]);
    const edges = canvas.listCanvases()[0].edges;
    // the line to the tester stays, as a plain line
    expect(edges.filter((e) => e.spec).map((e) => e.target)).toEqual([cards.builder]);
    expect(edges).toHaveLength(2);
    expect(() => canvas.setSpec(note, [note])).toThrow(/terminals/);
    expect(() => canvas.setSpec(cards.builder, [cards.tester])).toThrow(/Only a note/);
    const plain = canvas.addEdge(ws, cards.builder, cards.tester).id;
    expect(() => canvas.setEdgeSpec(plain, true)).toThrow(/note and a terminal/);
  });

  it("governs a relay line from either end, each note once", () => {
    const l = reviewLine();
    expect(canvas.specOfLine(l)).toEqual([]);
    canvas.setSpec(note, [cards.reviewer]);
    expect(canvas.specOfLine(l)).toEqual([note]);
    canvas.setSpec(note, [cards.builder, cards.reviewer]);
    expect(canvas.specOfLine(l)).toEqual([note]);
  });

  it("goes with the turn to the reviewer to judge against, not back with the review, and the history only says it went", async () => {
    const l = reviewLine();
    canvas.setSpec(note, [cards.builder]);
    await turn("bld", "builder");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("The spec you both work to:\n\n# Export");
    expect(sent[0].text).toContain("Judge the change against this spec");
    said.set("rev", "The header row is missing.");
    await turn("rev", "reviewer");
    expect(sent[1].id).toBe("bld");
    expect(sent[1].text).not.toContain("The spec you both work to:");
    const log = canvas.relayLog(l);
    expect(log[0]).toMatchObject({ kind: "forward", spec: [note] });
    expect(log[0].text).not.toContain("quotes every field");
    expect(log[1].spec).toBeUndefined();
  });

  it("goes along a line that doesn't review without the judging, and a replay takes the note as it is now", async () => {
    const l = canvas.addEdge(ws, cards.builder, cards.tester).id;
    canvas.setRelay(l, { from: "source", role: "build", limit: 3 });
    canvas.setSpec(note, [cards.tester]);
    await turn("bld", "builder");
    expect(sent[0].text).toContain("quotes every field");
    expect(sent[0].text).not.toContain("Judge");
    canvas.writeNote(note, "# Export\n\nTab separated now.");
    await replay(canvas.relayLog(l)[0].id);
    expect(sent[1].text).toContain("Tab separated now.");
    expect(sent[1].text).not.toContain("quotes every field");
    expect(canvas.relayLog(l).at(-1)).toMatchObject({ replay: expect.any(Number), spec: [note] });
  });

  it("goes once to each member of a panel, with the turn", async () => {
    const lines = [reviewLine(), canvas.addEdge(ws, cards.builder, cards.tester).id];
    canvas.setRelay(lines[1], { from: "both", role: "review", limit: 4 });
    joinPanel(lines[0], lines[1]);
    canvas.setSpec(note, [cards.builder]);
    await turn("bld", "builder");
    expect(sent.map((m) => m.id).sort()).toEqual(["rev", "tst"]);
    for (const m of sent) expect(m.text.split("The spec you both work to:")).toHaveLength(2);
    said.set("rev", "The header row is missing.");
    said.set("tst", "Fields with commas aren't quoted.");
    await turn("rev", "reviewer");
    await turn("tst", "tester");
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2].text).toContain("From the review panel");
    expect(sent[2].text).not.toContain("The spec you both work to:");
  });

  it("is sent once to every terminal it's the spec of, to start from, and says why it can't be", async () => {
    await expect(sendSpec(note)).rejects.toThrow(/isn't the spec of any terminal/);
    canvas.setSpec(note, [cards.builder, cards.tester]);
    const out = await sendSpec(note);
    expect(out.sent.sort()).toEqual(["bld title", "tst title"]);
    expect(sent.map((m) => m.id).sort()).toEqual(["bld", "tst"]);
    expect(sent[0].text).toContain("The spec you both work to:\n\n# Export");
    expect(sent[0].text).toContain("Read it before you start");
    const spec = canvas.specEdges(note)[0];
    expect(canvas.relayLog(spec.edge)).toEqual([expect.objectContaining({ kind: "spec", from: note, to: spec.card, outcome: "delivered" })]);
    canvas.writeNote(note, "  ");
    await expect(sendSpec(note)).rejects.toThrow(/empty/);
  });
});
