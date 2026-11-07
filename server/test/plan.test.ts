import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// each test a transcript of its own
const dir = mkdtempSync(join(tmpdir(), "plan-"));
let file = "";
const fresh = () => writeFileSync((file = join(dir, `${n++}.jsonl`)), "");
vi.mock("../src/claude/sessions.ts", () => ({ sessionFile: () => file }));
const { contextOf, planOf, stepsOf, describe: say, windowOf } = await import("../src/plan.ts");

let n = 0;
const ts = () => new Date(Date.UTC(2026, 10, 7, 10, 0, n++)).toISOString();
const call = (id: string, name: string, input: unknown) => JSON.stringify({ type: "assistant", uuid: `a${n}`, timestamp: ts(), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, text: string, is_error = false) => JSON.stringify({ type: "user", uuid: `u${n}`, timestamp: ts(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error }] } });
const add = (...lines: string[]) => appendFileSync(file, lines.join("\n") + "\n");

describe("a session's plan", () => {
  it("is the plan it last had approved, its to-do list and what it's doing now, read on as the file grows", async () => {
    fresh();
    expect(await planOf("s")).toEqual({ plan: undefined, todos: undefined, doing: [] });
    add(
      call("p1", "ExitPlanMode", { plan: "# Export\n\n1. Add the **button**\n2. Write `export.ts`\n3. Test it" }),
      result("p1", "User has approved your plan."),
      call("t1", "TodoWrite", { todos: [{ content: "Add the button", status: "completed" }, { content: "Write export.ts", status: "in_progress" }, { content: "Test it", status: "pending" }] }),
      result("t1", "ok"),
      call("e1", "Edit", { file_path: "/repo/web/src/Export.tsx" }),
      result("e1", "ok"),
    );
    const one = await planOf("s");
    expect(one.plan).toMatchObject({ approved: true, steps: ["Add the button", "Write export.ts", "Test it"] });
    expect(one.todos).toEqual([
      { text: "Add the button", status: "done" },
      { text: "Write export.ts", status: "doing" },
      { text: "Test it", status: "todo" },
    ]);
    expect(one.doing[0]).toMatchObject({ what: "Editing Export.tsx", done: true });
    // only what was added since is read
    add(call("b1", "Bash", { command: "pnpm test", description: "Run the tests" }));
    const two = await planOf("s");
    expect(two.doing[0]).toMatchObject({ what: "Run the tests", done: false });
    expect(two.todos).toEqual(one.todos);
  });

  it("follows the task tools, by the id each task comes back with", async () => {
    fresh();
    add(call("c1", "TaskCreate", { subject: "Read the ticket" }), result("c1", "Task #1 created successfully: Read the ticket"));
    add(call("c2", "TaskCreate", { subject: "Fix it" }), result("c2", "Task #2 created successfully: Fix it"));
    add(call("u1", "TaskUpdate", { taskId: "1", status: "completed" }), result("u1", "Updated task #1 status"));
    add(call("u2", "TaskUpdate", { taskId: "2", status: "in_progress" }), result("u2", "Updated task #2 status"));
    expect((await planOf("s")).todos).toEqual([
      { text: "Read the ticket", status: "done" },
      { text: "Fix it", status: "doing" },
    ]);
  });

  it("a plan turned down says so, and one not answered yet is waiting", async () => {
    fresh();
    add(call("p2", "ExitPlanMode", { plan: "- one\n- two" }), result("p2", "The user doesn't want to proceed", true));
    expect((await planOf("s")).plan?.approved).toBe(false);
    add(call("p3", "ExitPlanMode", { plan: "## First\n## Second" }));
    expect((await planOf("s")).plan).toMatchObject({ approved: undefined, steps: ["First", "Second"] });
  });

  it("says how full its context is from the main thread's last answer", async () => {
    fresh();
    expect(await contextOf("s")).toBeUndefined();
    const answer = (model: string, usage: object, more = {}) => JSON.stringify({ type: "assistant", timestamp: ts(), ...more, message: { role: "assistant", model, usage, content: [{ type: "text", text: "hi" }] } });
    add(answer("claude-sonnet-4-5", { input_tokens: 10, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 40 }));
    expect(await contextOf("s")).toEqual({ tokens: 150_050, window: 200_000, model: "claude-sonnet-4-5" });
    // a subagent's answer and an empty one (an interruption) don't count
    add(answer("claude-haiku-4-5", { input_tokens: 5 }, { isSidechain: true }), answer("claude-sonnet-4-5", { input_tokens: 0 }));
    expect((await contextOf("s"))?.tokens).toBe(150_050);
    expect(windowOf("claude-opus-5-5", 1000)).toBe(1_000_000);
    expect(windowOf("claude-sonnet-4-5", 250_000)).toBe(1_000_000);
  });

  it("names a tool call in a few words", () => {
    expect(say("Read", { file_path: "/a/b/c.ts" })).toBe("Reading c.ts");
    expect(say("Bash", { command: "git status" })).toBe("Running git status");
    expect(say("mcp__cockpit__report_run", {})).toBe("cockpit report_run");
    expect(stepsOf("no list here")).toEqual([]);
  });

  it("finds a plan's steps past its context, files and checks", () => {
    const plan = "# Export\n\n## Context\n\n1. Users asked for it\n2. It's slow today\n\n## Order\n\n1. The **button**\n2. The `export.ts` route\n\n## Files\n\n- a.ts\n\n## Verification\n\n1. pnpm test";
    expect(stepsOf(plan)).toEqual(["The button", "The export.ts route"]);
    // without a section of steps: the numbered list outside the context and the checks
    expect(stepsOf(plan.replace("## Order", "## Shape"))).toEqual(["The button", "The export.ts route"]);
    // nothing numbered: its sections, less the ones every plan has
    expect(stepsOf("# X\n## Context\ntext\n## Server\n- a\n## Web\n- b\n## Files\n- c")).toEqual(["Server", "Web"]);
  });
});
