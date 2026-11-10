import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelPart, Session, TermInfo } from "@cockpit/shared";

const sent: { id: string; text: string }[] = [];
// what each terminal's agent said last
const said = new Map<string, string>();
vi.mock("../src/agents.ts", () => ({
  lastWords: async (id: string) => ({ text: said.get(id) ?? "Added the export button and its test." }),
  sendText: async (id: string, text: string) => (sent.push({ id, text }), true),
}));
vi.mock("../src/runs.ts", () => ({ listRuns: () => [], settledFail: () => false }));
vi.mock("../src/remote/sessions.ts", () => ({ onNode: (_id: string, _remote: unknown, local: () => unknown) => Promise.resolve(local()) }));
// the local model: none unless a test gives one
const model = { answer: undefined as string | undefined, prompts: [] as string[] };
vi.mock("../src/quick.ts", async (orig) => ({ ...(await orig<typeof import("../src/quick.ts")>()), quick: async (p: string) => (model.prompts.push(p), model.answer) }));
const open: TermInfo[] = [];
vi.mock("../src/pty.ts", async (orig) => ({ ...(await orig<typeof import("../src/pty.ts")>()), listTerms: () => open, typeInto: () => {} }));

const { db } = await import("../src/db.ts");
const canvas = await import("../src/canvas.ts");
const { broadcast } = await import("../src/hub.ts");
const { joinPanel, panelWait, startRelays } = await import("../src/relay.ts");
const { Gather, mergeReviews, mergePrompt } = await import("../src/panel.ts");

const term = (id: string): TermInfo => ({ id, title: id, cwd: "/tmp", command: "claude", createdAt: 0, node: "local" });
const session = (id: string, termId: string, status: Session["status"]): Session => ({ id, project: "p", cwd: "/tmp", status, startedAt: 0, updatedAt: 0, size: 0, term: termId, title: `${id} title` });
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const edges = () => canvas.listCanvases()[0].edges;
const turn = async (who: string, termId: string) => {
  broadcast({ type: "sessions", sessions: [session(who, termId, "busy")] });
  broadcast({ type: "sessions", sessions: [session(who, termId, "idle")] });
  await settle();
};
const part = (name: string, outcome: PanelPart["outcome"], text?: string): PanelPart => ({ from: name, name, outcome, ...(text ? { text } : {}) });

describe("gathering a panel's reviews", () => {
  const members = [
    { edge: "e1", card: "c1", term: "t1", name: "Codex" },
    { edge: "e2", card: "c2", term: "t2", name: "Local" },
  ];

  it("is done once every member has answered, and only once", () => {
    const done = vi.fn();
    const g = new Gather(members, 60_000, done);
    expect(g.add("e1", "one")).toBe(true);
    expect(g.add("e1", "again")).toBe(false);
    expect(g.add("other", "x")).toBe(false);
    expect(done).not.toHaveBeenCalled();
    g.add("e2", "two");
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0]).toMatchObject({ timedOut: false });
    expect([...done.mock.calls[0][0].replies]).toEqual([
      ["e1", "one"],
      ["e2", "two"],
    ]);
    g.finish();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for one that's gone, and at the wait goes with what's in hand", async () => {
    const gone = vi.fn();
    const g = new Gather(members, 60_000, gone);
    g.add("e1", "one");
    g.drop("e2");
    expect(gone).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    const h = new Gather(members, 20, late);
    h.add("e2", "two");
    await settle(50);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0][0].timedOut).toBe(true);
    expect(h.add("e1", "too late")).toBe(false);
  });
});

describe("merging a panel's reviews", () => {
  it("asks the model for agreed points first, then each one raised by one with who, then disagreements", async () => {
    const parts = [part("Codex", "answered", "a.ts:3 drops the last row."), part("Local", "answered", "a.ts:3 is off by one. Name it better.")];
    const ask = vi.fn(async () => "## Agreed\n\na.ts:3 drops the last row.\n\n## Raised by one\n\nName it better. (Local)");
    const out = await mergeReviews(parts, "10 min", ask);
    expect(out).toEqual({ text: "## Agreed\n\na.ts:3 drops the last row.\n\n## Raised by one\n\nName it better. (Local)", merged: true });
    const prompt = mergePrompt(parts);
    expect(prompt.indexOf("## Agreed")).toBeLessThan(prompt.indexOf("## Raised by one"));
    expect(prompt.indexOf("## Raised by one")).toBeLessThan(prompt.indexOf("## Disagreements"));
    expect(prompt).toContain("### Codex\n\na.ts:3 drops the last row.");
  });

  it("without a model, puts each under its reviewer's name, and says who added nothing or didn't answer", async () => {
    const parts = [part("Codex", "answered", "a.ts:3 drops the last row."), part("Local", "answered", "Name it better."), part("Gemini", "acknowledged", "Looks good."), part("Other", "silent")];
    const out = await mergeReviews(parts, "10 min", async () => undefined);
    expect(out).toEqual({ text: "### Codex\n\na.ts:3 drops the last row.\n\n### Local\n\nName it better.\n\nGemini had nothing to add. Other didn't answer within 10 min.", merged: false });
    // a model that fails is no model
    expect((await mergeReviews(parts, "", () => Promise.reject(new Error("down"))))?.merged).toBe(false);
  });

  it("asks no model for one review, and has nothing when they only acknowledged or none answered", async () => {
    const ask = vi.fn(async () => "merged");
    expect(await mergeReviews([part("Codex", "answered", "Fix a.ts."), part("Local", "silent")], "10 min", ask)).toEqual({ text: "### Codex\n\nFix a.ts.\n\nLocal didn't answer within 10 min.", merged: false });
    expect(ask).not.toHaveBeenCalled();
    expect(await mergeReviews([part("Codex", "acknowledged", "OK"), part("Local", "acknowledged", "Thanks")], "", ask)).toBeUndefined();
    expect(await mergeReviews([part("Codex", "silent")], "", ask)).toBeUndefined();
  });
});

describe("a panel of reviewers on the canvas", () => {
  beforeAll(() => startRelays());
  // the author, two reviewers, a review line to each, in one panel
  let lines: string[] = [];
  beforeEach(() => {
    db.exec("delete from canvas_nodes; delete from canvas_edges; delete from canvases; delete from canvas_relay_log;");
    sent.length = 0;
    said.clear();
    model.answer = undefined;
    model.prompts.length = 0;
    panelWait.ms = () => 60_000;
    canvas.syncTerms([term("author"), term("codex"), term("local")]);
    const main = canvas.listCanvases()[0];
    const card = (ref: string) => main.nodes.find((n) => n.ref === ref)!.id;
    lines = [canvas.addEdge(main.id, card("author"), card("codex")).id, canvas.addEdge(main.id, card("author"), card("local")).id];
    for (const l of lines) canvas.setRelay(l, { from: "both", role: "review", limit: 4 });
    joinPanel(lines[0], lines[1]);
    broadcast({ type: "sessions", sessions: [session("au", "author", "idle"), session("cx", "codex", "idle"), session("lc", "local", "idle")] });
  });

  it("joins and leaves only review lines of the same author, and a panel of one is a review line again", () => {
    expect(edges().map((e) => e.relay?.panel)).toEqual([expect.any(String), edges()[0].relay?.panel]);
    joinPanel(lines[1], null);
    expect(edges().map((e) => e.relay?.panel)).toEqual([undefined, undefined]);
    const main = canvas.listCanvases()[0];
    const card = (ref: string) => main.nodes.find((n) => n.ref === ref)!.id;
    const across = canvas.addEdge(main.id, card("codex"), card("local")).id;
    canvas.setRelay(across, { from: "source", role: "review", limit: 3 });
    expect(() => joinPanel(lines[0], across)).toThrow(/same terminal/);
    canvas.setRelay(across, { from: "source", role: "plan", limit: 3 });
    expect(() => joinPanel(across, lines[0])).toThrow(/review line/);
    // kept through settings changes on the line
    joinPanel(lines[0], lines[1]);
    canvas.setRelay(lines[0], { ...edges()[0].relay!, limit: 2 });
    expect(edges()[0].relay?.panel).toBe(edges()[1].relay?.panel);
  });

  it("hands every member the turn, and the author one merged review once they've all answered, as one hop", async () => {
    model.answer = "## Agreed\n\nexport.ts:9 skips the header.";
    await turn("au", "author");
    expect(sent.map((m) => m.id).sort()).toEqual(["cx", "lc"]);
    said.set("cx", "export.ts:9 skips the header.");
    said.set("lc", "The header is missing in export.ts:9, and the test only checks rows.");
    await turn("cx", "codex");
    // still waiting for the other review
    expect(sent).toHaveLength(2);
    expect(edges()[0].status).toMatchObject({ state: "held", text: expect.stringContaining("panel") });
    await turn("lc", "local");
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2].id).toBe("au");
    expect(sent[2].text).toContain("From the review panel (cx title, lc title), which just reviewed your last turn");
    expect(sent[2].text).toContain("export.ts:9 skips the header.");
    expect(sent[2].text).toContain("Fix what it's right about");
    expect(model.prompts[0]).toContain("### lc title");
    // a hop out and one back on each line
    expect(edges().map((e) => e.hops)).toEqual([2, 2]);
    // the history keeps each review as it came, and the merged one with them all in it
    const log = canvas.relayLog(lines[0]);
    expect(log.map((e) => [e.kind, e.outcome])).toEqual([
      ["forward", "delivered"],
      ["back", "delivered"],
      ["panel", "delivered"],
    ]);
    expect(log[1].text).toBe("export.ts:9 skips the header.");
    expect(log[2].text).toBe(sent[2].text);
    expect(log[2].parts?.map((p) => [p.name, p.outcome])).toEqual([
      ["cx title", "answered"],
      ["lc title", "answered"],
    ]);
    expect(canvas.relayLog(lines[1]).at(-1)).toMatchObject({ kind: "panel", outcome: "delivered" });
  });

  it("sends nothing back when every member only acknowledged", async () => {
    await turn("au", "author");
    said.set("cx", "Thanks, all good.");
    said.set("lc", "OK");
    await turn("cx", "codex");
    await turn("lc", "local");
    await settle();
    expect(sent.map((m) => m.id)).not.toContain("au");
    expect(canvas.relayLog(lines[0]).at(-1)).toMatchObject({ kind: "panel", outcome: "stopped-ack" });
    expect(edges().map((e) => e.hops)).toEqual([1, 1]);
  });

  it("at the wait, goes with the reviews in hand under their names and says who didn't answer", async () => {
    panelWait.ms = () => 80;
    await turn("au", "author");
    said.set("cx", "export.ts:9 skips the header.");
    await turn("cx", "codex");
    expect(sent.map((m) => m.id)).not.toContain("au");
    await vi.waitFor(() => expect(sent.map((m) => m.id)).toContain("au"));
    const back = sent.find((m) => m.id === "au")!.text;
    expect(back).toContain("### cx title\n\nexport.ts:9 skips the header.");
    expect(back).toContain("lc title didn't answer within");
    const log = canvas.relayLog(lines[1]);
    expect(log.at(-1)?.parts?.map((p) => p.outcome)).toEqual(["answered", "silent"]);
    // the late one goes along its line as a review on its own
    said.set("lc", "The test only checks rows.");
    await turn("lc", "local");
    expect(sent.filter((m) => m.id === "au")).toHaveLength(2);
  });

  it("stops waiting for a reviewer whose session ended", async () => {
    await turn("au", "author");
    said.set("cx", "export.ts:9 skips the header.");
    await turn("cx", "codex");
    broadcast({ type: "sessions", sessions: [session("lc", "local", "ended")] });
    await vi.waitFor(() => expect(sent.map((m) => m.id)).toContain("au"));
    expect(sent.find((m) => m.id === "au")!.text).toContain("lc title didn't answer.");
  });
});
