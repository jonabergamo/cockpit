import { describe, expect, it } from "vitest";
import type { CodeHost, Cockpit } from "@cockpit/shared";
import github from "../../plugins/github/server.ts";
import { readOutcome } from "../src/reviews.ts";
import { objectAt, usageOf } from "../src/usage.ts";

const assistant = (content: unknown, usage: object) =>
  JSON.stringify({ type: "assistant", requestId: "req_1", sessionId: "s1", timestamp: "2026-10-20T10:00:00Z", message: { model: "claude-opus-5-5", content, usage } });

describe("usageOf", () => {
  it("reads the usage of an assistant line", () => {
    const u = usageOf(assistant([{ type: "text", text: "hi" }], { input_tokens: 3, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, output_tokens_details: { thinking_tokens: 7 } }));
    expect(u).toEqual({ requestId: "req_1", sessionId: "s1", ts: "2026-10-20T10:00:00Z", model: "claude-opus-5-5", input: 3, output: 50, cacheRead: 900, cacheWrite: 40, thinking: 7 });
  });

  it("isn't fooled by usage-looking text or objects in the content", () => {
    const content = [
      { type: "text", text: 'the "usage":{"output_tokens":999} key, and a } brace' },
      { type: "tool_use", id: "t", name: "Write", input: { usage: { output_tokens: 777 } } },
    ];
    expect(usageOf(assistant(content, { input_tokens: 1, output_tokens: 2 }))?.output).toBe(2);
  });

  it("skips other line types", () => {
    expect(usageOf(JSON.stringify({ type: "user", message: { content: "x" } }))).toBeUndefined();
  });

  it("cuts out an object with braces inside strings", () => {
    const line = 'x {"a":"}{","b":{"c":1}} tail';
    expect(objectAt(line, 2)).toBe('{"a":"}{","b":{"c":1}}');
  });
});

describe("reviews", () => {
  it("parses PR links and numbers", () => {
    // the GitHub plugin, set up with just enough of the host to hand back its code host
    let host: CodeHost | undefined;
    github({ setting: (k: string) => (k === "repo" ? "owner/repo" : undefined), codeHost: (h: CodeHost) => (host = h), ticketOf: () => undefined } as unknown as Cockpit);
    const parsePr = host!.parsePr!;
    expect(parsePr("https://github.com/acme/shop/pull/1288/files")).toEqual({ repo: "acme/shop", n: 1288 });
    expect(parsePr("#12")).toEqual({ repo: "owner/repo", n: 12 });
    expect(parsePr("nope")).toBeUndefined();
  });

  it("finds the latest verdict and pending review link", () => {
    const out = readOutcome([
      "Looking at the diff",
      "Posted 3 comments: https://github.com/acme/shop/pull/1288#pullrequestreview-555.\n\nApproved with comments, two small things in the hook.",
    ]);
    expect(out).toEqual({ reviewUrl: "https://github.com/acme/shop/pull/1288#pullrequestreview-555", verdict: "Approved with comments" });
  });
});

import { commandHead, toolsOf } from "../src/usage.ts";

describe("tool usage", () => {
  it("names the command a Bash call ran", () => {
    expect(commandHead("cd web && pnpm test --filter web")).toBe("pnpm test");
    expect(commandHead("NODE_ENV=test node scripts/x.mjs")).toBe("node scripts/x.mjs");
    expect(commandHead("/usr/bin/rg -n foo src")).toBe("rg");
    expect(commandHead("git status -sb")).toBe("git status");
  });
  it("reads calls and result sizes off transcript lines", () => {
    const call = JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: "2026-10-01T00:00:00Z", message: { content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: "ls -la" } }] } });
    const result = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "a".repeat(400) }] } });
    expect(toolsOf(call).calls).toEqual([{ id: "u1", tool: "Bash", detail: "ls", ts: "2026-10-01T00:00:00Z", sessionId: "s1" }]);
    expect(toolsOf(result).results).toEqual([{ id: "u1", chars: 400 }]);
    expect(toolsOf('{"type":"assistant"}')).toEqual({ calls: [], results: [] });
  });
});
