import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, TermInfo } from "@cockpit/shared";

const sent: { id: string; text: string }[] = [];
vi.mock("../src/agents.ts", () => ({
  lastWords: async () => ({ text: "Added the export button and its test." }),
  sendText: async (id: string, text: string) => (sent.push({ id, text }), true),
}));
// the runs the source terminal did, for the lines that only pass on passing work
const failingRuns: { name: string; status: "fail"; meta: Record<string, unknown> }[] = [];
vi.mock("../src/runs.ts", () => ({ listRuns: () => failingRuns, settledFail: (r: { meta: Record<string, unknown> }) => !!r.meta.fixedBy }));
vi.mock("../src/remote/sessions.ts", () => ({ onNode: (_id: string, _remote: unknown, local: () => unknown) => Promise.resolve(local()) }));
// the terminals open, and what's typed straight into them
const open: TermInfo[] = [];
const typed: { id: string; data: string }[] = [];
vi.mock("../src/pty.ts", async (orig) => ({ ...(await orig<typeof import("../src/pty.ts")>()), listTerms: () => open, typeInto: (id: string, data: string) => void typed.push({ id, data }) }));

const { db } = await import("../src/db.ts");
const canvas = await import("../src/canvas.ts");
const { broadcast } = await import("../src/hub.ts");
const { input } = await import("../src/pty.ts");
const { relayMessage, startRelays } = await import("../src/relay.ts");

const term = (id: string): TermInfo => ({ id, title: id, cwd: "/tmp", command: "claude", createdAt: 0, node: "local" });
const session = (id: string, termId: string, status: Session["status"]): Session => ({ id, project: "p", cwd: "/tmp", status, startedAt: 0, updatedAt: 0, size: 0, term: termId, title: `${id} title` });
const settle = () => new Promise((r) => setTimeout(r, 20));
const line = () => canvas.listCanvases()[0].edges[0];

beforeAll(() => startRelays());
beforeEach(() => {
  db.exec("delete from canvas_nodes; delete from canvas_edges; delete from canvases;");
  sent.length = 0;
  canvas.syncTerms([term("builder"), term("reviewer")]);
  const main = canvas.listCanvases()[0];
  const [a, b] = main.nodes;
  canvas.addEdge(main.id, a.id, b.id);
});

const turn = async (who: string, termId: string) => {
  broadcast({ type: "sessions", sessions: [session(who, termId, "busy")] });
  broadcast({ type: "sessions", sessions: [session(who, termId, "idle")] });
  await settle();
};

describe("relays", () => {
  it("only relays between two terminals, in a way it knows", () => {
    const main = canvas.listCanvases()[0];
    const note = canvas.addNote(main.id);
    const toNote = canvas.addEdge(main.id, main.nodes[0].id, note.id);
    expect(() => canvas.setRelay(toNote.id, { from: "both", role: "review", limit: 3 })).toThrow(/two terminals/);
    expect(() => canvas.setRelay(line().id, { from: "both", role: "custom", limit: 3 })).toThrow(/Say what/);
    canvas.setRelay(line().id, { from: "source", role: "review", limit: 99 });
    expect(line()).toMatchObject({ relay: { from: "source", role: "review", limit: 20 }, hops: 0 });
  });

  it("passes a finished turn on to the other end's agent, with what to do with it", async () => {
    canvas.setRelay(line().id, { from: "source", role: "review", limit: 3 });
    broadcast({ type: "sessions", sessions: [session("rev", "reviewer", "idle")] });
    await turn("bld", "builder");
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe("rev");
    expect(sent[0].text).toContain("From bld title");
    expect(sent[0].text).toContain("Added the export button");
    expect(sent[0].text).toContain("Review this work");
    expect(line().hops).toBe(1);
    expect(line().status).toMatchObject({ state: "sent", text: "Passed on to rev title" });
  });

  it("only goes the way it's set to", async () => {
    canvas.setRelay(line().id, { from: "source", role: "review", limit: 3 });
    broadcast({ type: "sessions", sessions: [session("bld", "builder", "idle")] });
    await turn("rev", "reviewer");
    expect(sent).toEqual([]);
  });

  it("holds the message while the other end is busy, and hands it over once it's idle", async () => {
    canvas.setRelay(line().id, { from: "both", role: "build", limit: 3 });
    broadcast({ type: "sessions", sessions: [session("rev", "reviewer", "busy")] });
    await turn("bld", "builder");
    expect(sent).toEqual([]);
    expect(line().status).toMatchObject({ state: "held", text: expect.stringContaining("busy") });
    // the reviewer finishing its own turn gets the held message, and its turn goes back the other way
    broadcast({ type: "sessions", sessions: [session("bld", "builder", "idle"), session("rev", "reviewer", "idle")] });
    await settle();
    expect(sent.map((m) => m.id)).toEqual(["rev", "bld"]);
  });

  it("stops at its limit, and starts again once you type into either end", async () => {
    canvas.setRelay(line().id, { from: "both", role: "custom", prompt: "Answer it.", limit: 2 });
    broadcast({ type: "sessions", sessions: [session("rev", "reviewer", "idle")] });
    await turn("bld", "builder");
    await turn("bld", "builder");
    await turn("bld", "builder");
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain("2 of 2");
    expect(sent[1].text).toContain("Answer it.");
    input("reviewer", "x");
    expect(line().hops).toBe(0);
    await turn("bld", "builder");
    expect(sent).toHaveLength(3);
  });

  it("types into an agent just opened, which has no session yet, but never into a shell", async () => {
    canvas.syncTerms([term("lead"), term("newbie"), { ...term("plain"), command: "bash" }]);
    open.push(term("newbie"), { ...term("plain"), command: "bash" });
    const main = canvas.listCanvases()[0];
    const card = (ref: string) => main.nodes.find((n) => n.ref === ref)?.id ?? canvas.listCanvases()[0].nodes.find((n) => n.ref === ref)!.id;
    const toNew = canvas.addEdge(main.id, card("lead"), card("newbie"));
    const toShell = canvas.addEdge(main.id, card("lead"), card("plain"));
    canvas.setRelay(toNew.id, { from: "source", role: "review", limit: 3 });
    canvas.setRelay(toShell.id, { from: "source", role: "review", limit: 3 });
    await turn("ld", "lead");
    await new Promise((r) => setTimeout(r, 350));
    expect(sent).toEqual([]);
    expect(typed.map((t) => t.id)).toEqual(["newbie", "newbie"]);
    expect(typed[0].data).toMatch(/^\x1b\[200~From ld title[\s\S]*Review this work[\s\S]*\x1b\[201~$/);
    expect(typed[1].data).toBe("\r");
    const hops = (id: string) => canvas.listCanvases()[0].edges.find((e) => e.id === id)?.hops;
    expect(hops(toNew.id)).toBe(1);
    expect(hops(toShell.id)).toBe(0);
    // the line to the shell says why nothing went along it
    const status = (id: string) => canvas.listCanvases()[0].edges.find((e) => e.id === id)?.status;
    expect(status(toShell.id)).toMatchObject({ state: "failed", text: expect.stringContaining("isn't running an agent") });
    expect(status(toNew.id)).toMatchObject({ state: "sent" });
    // set up again, it starts clean
    canvas.setRelay(toShell.id, { from: "source", role: "plan", limit: 3 });
    expect(status(toShell.id)).toBeUndefined();
  });

  it("holds a turn back while its checks fail, on a line that only passes on passing work", async () => {
    canvas.setRelay(line().id, { from: "source", role: "review", limit: 3, when: "passing" });
    expect(line().relay?.when).toBe("passing");
    broadcast({ type: "sessions", sessions: [session("rev", "reviewer", "idle")] });
    failingRuns.push({ name: "pnpm lint", status: "fail", meta: {} });
    await turn("bld", "builder");
    expect(sent).toEqual([]);
    expect(line()).toMatchObject({ hops: 0, status: { state: "held", text: expect.stringContaining("pnpm lint failing") } });
    // fixed since: the next turn goes
    failingRuns[0].meta.fixedBy = "later";
    await turn("bld", "builder");
    expect(sent).toHaveLength(1);
    failingRuns.length = 0;
  });

  it("says where it came from and how far along it is", () => {
    expect(relayMessage("Builder", "Done.", { from: "both", role: "plan", limit: 4 }, 2)).toBe("From Builder, which just finished a turn:\n\nDone.\n\nTurn this into the next concrete steps, in order.\n\n(Passed on by cockpit's canvas, 2 of 4.)");
  });
});
