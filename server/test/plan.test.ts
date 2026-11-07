import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// each test a transcript of its own
const dir = mkdtempSync(join(tmpdir(), "plan-"));
let file = "";
const fresh = () => writeFileSync((file = join(dir, `${n++}.jsonl`)), "");
vi.mock("../src/claude/sessions.ts", () => ({ sessionFile: () => file, getSession: () => undefined }));
// Claude Code's folder, where cockpit's status line writes
const claudeDir = mkdtempSync(join(tmpdir(), "claude-"));
vi.mock("../src/config.ts", async (orig) => {
  const o = await orig<typeof import("../src/config.ts")>();
  return { ...o, config: { ...o.config, claude: { ...o.config.claude, dir: claudeDir } } };
});
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
    expect(await contextOf("s")).toEqual({ tokens: 150_050, window: 200_000, pct: 75, model: "claude-sonnet-4-5" });
    // a subagent's answer and an empty one (an interruption) don't count
    add(answer("claude-haiku-4-5", { input_tokens: 5 }, { isSidechain: true }), answer("claude-sonnet-4-5", { input_tokens: 0 }));
    expect((await contextOf("s"))?.tokens).toBe(150_050);
    expect(windowOf("claude-opus-5-5", 1000)).toBe(1_000_000);
    expect(windowOf("claude-sonnet-4-5", 250_000)).toBe(1_000_000);
  });

  it("takes Claude Code's own numbers from cockpit's status line once it has written them", async () => {
    fresh();
    const bin = new URL("../../bin/cockpit-statusline", import.meta.url).pathname;
    const line = { session_id: "with-line", model: { id: "claude-opus-5-5", display_name: "Opus 5.5" }, effort: { level: "medium" }, cost: { total_cost_usd: 94.18, total_duration_ms: 92_000_000, total_lines_added: 9751, total_lines_removed: 462 }, context_window: { context_window_size: 1_000_000, used_percentage: 23.4 }, rate_limits: { five_hour: { used_percentage: 3 } } };
    // the status line prints nothing, so the terminal shows none
    expect(execFileSync(bin, { input: JSON.stringify(line), env: { ...process.env, COCKPIT_CLAUDE_DIR: claudeDir } }).toString()).toBe("");
    expect(await contextOf("with-line")).toMatchObject({ window: 1_000_000, pct: 23, model: "Opus 5.5", effort: "medium", costUSD: 94.18, durationMs: 92_000_000, added: 9751, removed: 462 });
    // and where it's working, as the terminal's status line showed it: the folder, the branch, uncommitted work,
    // the plan's five hours (and when they start again) and its week
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    const g = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    g("init", "-q", "-b", "feature/ABC-12-export");
    writeFileSync(join(repo, "a.txt"), "a");
    g("add", ".");
    g("commit", "-qm", "a");
    writeFileSync(join(repo, "b.txt"), "not committed");
    mkdirSync(join(repo, "web"));
    const resets = Math.round(Date.now() / 1000) + 3600;
    const where = { ...line, session_id: "where", workspace: { current_dir: join(repo, "web"), project_dir: repo }, rate_limits: { five_hour: { used_percentage: 3.2, resets_at: resets }, seven_day: { used_percentage: 19 } } };
    execFileSync(bin, { input: JSON.stringify(where), env: { ...process.env, COCKPIT_CLAUDE_DIR: claudeDir } });
    expect(await contextOf("where")).toMatchObject({ dir: `${basename(repo)}/web`, branch: "feature/ABC-12-export", dirty: true, five: { pct: 3, resetsAt: resets }, seven: { pct: 19 } });
    // and the plan's limits, for the Usage screen
    mkdirSync(join(claudeDir, "cockpit"), { recursive: true });
    expect(JSON.parse(readFileSync(join(claudeDir, "cockpit", "rate-limits.json"), "utf8")).rate_limits.five_hour.used_percentage).toBe(3.2);
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
