import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentProvider, Session } from "@cockpit/shared";
import { describe, expect, it } from "vitest";
import { getSession, localSessions } from "../src/claude/sessions.ts";
import { tailEntries } from "../src/claude/entries.ts";
import { onEvent } from "../src/events.ts";
import { claude } from "../src/workers/claude.ts";
import { codex } from "../src/workers/codex.ts";
import { gemini } from "../src/workers/gemini.ts";
import { agentProvider, useExtraAgents } from "../src/workers/index.ts";
import { agentRow, closeAgent, sendAgent, startAgent } from "../src/workers/runner.ts";
import { sendText } from "../src/agents.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/agents", name), "utf8").split("\n").filter(Boolean);
const parseAll = (p: AgentProvider, lines: string[]) => {
  const state = {};
  return lines.flatMap((l) => p.parse(l, state));
};
const kinds = (evs: AgentEvent[]) => evs.map((e) => e.kind);

describe("agent output", () => {
  it("reads a Codex turn", () => {
    const evs = parseAll(codex, fixture("codex.jsonl"));
    expect(kinds(evs)).toEqual(["session", "message", "tool", "tool_result", "message", "usage", "done"]);
    expect(evs[0]).toEqual({ kind: "session", id: "01a16f1c-7241-72f1-a29d-dc4c4fba898c" });
    expect(evs[2]).toMatchObject({ kind: "tool", name: "Bash" });
    expect(evs.at(-2)).toEqual({ kind: "usage", input: 29359, output: 59, cached: 24576 });
    expect(evs.at(-1)).toEqual({ kind: "done", ok: true, text: "DONE" });
  });

  it("reads a Claude turn", () => {
    const evs = parseAll(claude, fixture("claude.jsonl"));
    expect(evs[0]).toMatchObject({ kind: "session", id: "b21a3ddc-6cc5-404a-8176-97b92297d67f" });
    expect(kinds(evs).filter((k) => k === "tool")).toHaveLength(2);
    expect(kinds(evs).filter((k) => k === "tool_result")).toHaveLength(2);
    expect(evs.find((e) => e.kind === "usage")).toMatchObject({ costUSD: expect.any(Number) });
    expect(evs.at(-1)).toEqual({ kind: "done", ok: true, text: "DONE" });
  });

  it("puts Gemini's answer back together", () => {
    const evs = parseAll(gemini, fixture("gemini.jsonl"));
    expect(kinds(evs)).toEqual(["session", "message", "tool", "tool_result", "message", "usage", "done"]);
    expect(evs[1]).toEqual({ kind: "message", text: "I'll append the line." });
    expect(evs.at(-1)).toEqual({ kind: "done", ok: true, text: "DONE" });
  });

  it("asks each CLI for one turn, resumed and with the access given", () => {
    const turn = { prompt: "x", cwd: "/w", access: "sandbox" as const, writable: ["/repo/.git"] };
    expect(codex.headless(turn)).toEqual(["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"', "-c", 'sandbox_workspace_write.writable_roots=["/repo/.git"]', "-"]);
    expect(codex.headless({ ...turn, resume: "t1", model: "m", access: "readonly" })).toEqual(["exec", "resume", "--json", "--skip-git-repo-check", "-m", "m", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "t1", "-"]);
    expect(claude.headless({ ...turn, resume: "s1" })).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--resume", "s1", "--permission-mode", "acceptEdits", "--add-dir", "/repo/.git"]);
    expect(gemini.headless({ ...turn, access: "full" })).toContain("yolo");
  });
});

// a stand-in agent that answers like Codex
const script = join(import.meta.dirname, "fixtures/fake-agent.mjs");
useExtraAgents(() => [{ ...codex, id: "fake", name: "Fake", bin: "node", models: () => [], headless: (t) => [script, ...(t.resume ? ["--resume", t.resume] : [])] }]);

const idleOnce = (id: string) =>
  new Promise<Session>((resolve) => {
    const off = onEvent((event, data) => {
      if (event === "session.idle" && (data as Session).id === id) {
        off();
        resolve(data as Session);
      }
    });
  });

describe("agent sessions", () => {
  it("runs a turn, keeps what it said and resumes the conversation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-"));
    expect(agentProvider("fake")).toBeDefined();
    const id = startAgent({ agent: "fake", cwd, prompt: "EDIT something" });
    expect(getSession(id)).toMatchObject({ agent: "fake", status: "busy", cwd });
    const s = await idleOnce(id);
    expect(s.status).toBe("idle");
    expect(existsSync(join(cwd, "touched.txt"))).toBe(true);
    const row = agentRow(id)!;
    expect(row.native_id).toMatch(/^thread-/);
    expect([row.tokens_in, row.tokens_out]).toEqual([100, 12]);

    // a follow-up goes on the same thread
    const next = idleOnce(id);
    expect(await sendText(id, "and then")).toBe(true);
    await next;
    const entries = (await tailEntries(id))!.entries;
    expect(entries.map((e) => e.kind)).toEqual(["user", "tool", "tool_result", "assistant", "user", "assistant"]);
    expect(entries.at(-1)).toMatchObject({ kind: "assistant", text: "again: and then" });
    expect(agentRow(id)!.native_id).toBe(row.native_id);
    expect(localSessions().some((x) => x.id === id)).toBe(true);
  });

  it("holds a prompt sent mid-turn for the next one", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-"));
    const id = startAgent({ agent: "fake", cwd, prompt: "SLOW start" });
    sendAgent(id, "queued one");
    // the first idle comes only once the queued prompt has had its turn too
    await idleOnce(id);
    const said = (await tailEntries(id))!.entries.filter((e) => e.kind === "assistant").map((e) => (e as { text: string }).text);
    expect(said).toEqual(["first: SLOW start", "again: queued one"]);
  });

  it("says why a turn failed and can go on after", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-"));
    const id = startAgent({ agent: "fake", cwd, prompt: "FAIL please" });
    await idleOnce(id);
    expect(agentRow(id)!.error).toBe("the model said no");
    const crashed = startAgent({ agent: "fake", cwd, prompt: "CRASH" });
    await idleOnce(crashed);
    expect(agentRow(crashed)!.error).toContain("something broke");
    closeAgent(crashed);
    expect(getSession(crashed)!.status).toBe("ended");
  });
});
