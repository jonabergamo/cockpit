import { describe, expect, it } from "vitest";
import { parseLine, type Meta } from "../src/claude/transcript.ts";

const line = (o: object) => JSON.stringify(o);

describe("parseLine", () => {
  it("splits assistant content blocks into entries", () => {
    const out = parseLine(
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-10-20T10:00:00Z",
        message: {
          model: "m",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "hello" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    );
    expect(out.map((e) => e.kind)).toEqual(["thinking", "assistant", "tool"]);
    expect(out[2]).toMatchObject({ toolUseId: "t1", name: "Bash" });
  });

  it("reads tool results and skips system reminders and meta lines", () => {
    const out = parseLine(
      line({
        type: "user",
        uuid: "u1",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }], is_error: true },
            { type: "text", text: "<system-reminder>x</system-reminder>" },
          ],
        },
      }),
    );
    expect(out).toEqual([{ kind: "tool_result", id: "u1:0", ts: "", toolUseId: "t1", text: "ok", isError: true }]);
    expect(parseLine(line({ type: "user", isMeta: true, message: { content: "x" } }))).toEqual([]);
  });

  it("ignores noise and collects metadata", () => {
    const meta: Meta = {};
    expect(parseLine('{"type":"api-request","x":1}', meta)).toEqual([]);
    parseLine(line({ type: "ai-title", aiTitle: "Fix login" }), meta);
    parseLine(line({ type: "user", uuid: "u", gitBranch: "feat/ACME-1/x", cwd: "/w", timestamp: "t1", message: { content: "hi" } }), meta);
    parseLine(line({ type: "cost-state", totalCostUSD: 1.5, totalLinesAdded: 3, totalLinesRemoved: 1 }), meta);
    expect(meta).toMatchObject({ title: "Fix login", branch: "feat/ACME-1/x", cwd: "/w", costUSD: 1.5, firstTs: "t1" });
  });

  it("survives broken json", () => {
    expect(parseLine("{not json")).toEqual([]);
  });
});
