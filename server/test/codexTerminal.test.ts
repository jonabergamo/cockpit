import { describe, expect, it } from "vitest";
import { codexEntries } from "../src/claude/codexTerminal.ts";

const item = (payload: object, ordinal = 1) => JSON.stringify({ timestamp: "2026-10-27T00:48:23.603Z", ordinal, type: "response_item", payload });

describe("a Codex terminal session's transcript", () => {
  it("keeps what you typed and leaves out the context Codex adds", () => {
    expect(codexEntries(item({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/x</cwd>" }] }))).toEqual([]);
    expect(codexEntries(item({ type: "message", role: "user", content: [{ type: "input_text", text: "fix the add" }] }))).toMatchObject([{ kind: "user", text: "fix the add" }]);
    expect(codexEntries(item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }))).toMatchObject([{ kind: "assistant", text: "Done." }]);
  });

  it("shows a shell command as one, and its output without the script's preamble", () => {
    const call = codexEntries(item({ type: "custom_tool_call", call_id: "c1", name: "exec", input: 'const r = await tools.exec_command({cmd:"python3 test_calc.py",max_output_tokens:1000});text(r.output);' }));
    expect(call).toMatchObject([{ kind: "tool", toolUseId: "c1", name: "Bash", input: { command: "python3 test_calc.py" } }]);
    const mcp = codexEntries(item({ type: "custom_tool_call", call_id: "c2", name: "exec", input: "text(await tools.mcp__cockpit__list_workers({}));" }));
    expect(mcp).toMatchObject([{ name: "cockpit.list_workers" }]);
    const out = codexEntries(item({ type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "Script completed\nWall time 0.3 seconds\nOutput:\n1 passed" }] }));
    expect(out).toMatchObject([{ kind: "tool_result", toolUseId: "c1", text: "1 passed", isError: false }]);
  });
});
