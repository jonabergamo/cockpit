import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { db } from "../src/db.ts";
import { appendRun, countsOf, dropFailedVideos, filesDir, finishRun, fromHook, getRun, kindOf, listRuns, outputTail, placeOf, recordHook, recordRun, screenLines, startRun, stepLines, sweep } from "../src/runs.ts";

describe("kindOf", () => {
  it("knows the usual runners", () => {
    expect(kindOf("pnpm test")).toBe("unit");
    expect(kindOf("cd server && pnpm --filter server test 2>&1 | tail -20")).toBe("unit");
    expect(kindOf("npx vitest run src/x.test.ts")).toBe("unit");
    expect(kindOf("pnpm run fix:all")).toBe("lint");
    expect(kindOf("npx tsc --noEmit")).toBe("typecheck");
    expect(kindOf("pnpm audit --prod")).toBe("audit");
    expect(kindOf("maestro test flows/shop/x.yaml")).toBe("e2e");
    expect(kindOf("pnpm run test:e2e")).toBe("e2e");
  });
  it("leaves other commands and quoted text alone", () => {
    expect(kindOf("pnpm build")).toBeUndefined();
    expect(kindOf('git commit -m "fix the failing test and lint"')).toBeUndefined();
    expect(kindOf("ls tests/")).toBeUndefined();
  });
  it("ignores paths, cd, variables and heredoc bodies", () => {
    expect(kindOf("cd /wt/app/e2e/src/maestro && ls flows/hd")).toBeUndefined();
    expect(kindOf("cat src/maestro/flows/x.yaml | head")).toBeUndefined();
    expect(kindOf("python3 - <<'EOF'\nprint('pnpm run e2e and maestro test')\nEOF\ncd ../.. && git status")).toBeUndefined();
    expect(kindOf("cd /wt/app/e2e && RECORD_VIDEO=0 pnpm run e2e flows/hd/x.yaml")).toBe("e2e");
    expect(kindOf("~/.maestro/bin/maestro test flows/x.yaml")).toBe("e2e");
    expect(kindOf("pnpm test 2>&1 | tail -20")).toBe("unit");
  });
  it("uses the patterns it's given, and an empty one turns a kind off", () => {
    const patterns = { e2e: "", audit: "", typecheck: "", lint: "", unit: "\\bmake check\\b" };
    expect(kindOf("make check", patterns)).toBe("unit");
    expect(kindOf("maestro test x.yaml", patterns)).toBeUndefined();
  });
});

describe("placeOf", () => {
  const worktrees = [
    { path: "/repo", branch: "main", main: true },
    { path: "/wt/ACME-1/fix", branch: "feat/ACME-1/fix", ticket: "ACME-1", main: false },
  ];
  it("finds the worktree a cwd is in, and its ticket", () => expect(placeOf({ cwd: "/wt/ACME-1/fix/server" }, worktrees)).toEqual({ worktree: "/wt/ACME-1/fix", ticket: "ACME-1" }));
  it("finds it by branch", () => expect(placeOf({ branch: "feat/ACME-1/fix" }, worktrees).worktree).toBe("/wt/ACME-1/fix"));
  it("takes a key from the name when there's no worktree", () => expect(placeOf({ name: "ACME-77-change-unit", cwd: "/tmp" }, worktrees)).toEqual({ worktree: undefined, ticket: "ACME-77" }));
  it("keeps a ticket it was given", () => expect(placeOf({ cwd: "/wt/ACME-1/fix", ticket: "ACME-9" }, worktrees).ticket).toBe("ACME-9"));
});

describe("countsOf", () => {
  it("reads vitest", () => {
    const out = [" × adds things 3ms", " FAIL  test/a.test.ts > maths > adds things", " Test Files  1 failed | 4 passed (5)", "      Tests  1 failed | 30 passed | 2 skipped (33)"];
    expect(countsOf(out)).toEqual({ failed: 1, passed: 30, skipped: 2, failing: ["adds things", "test/a.test.ts > maths > adds things"] });
  });
  it("reads jest", () => expect(countsOf(["Tests:       2 failed, 1 skipped, 10 passed, 13 total"])).toMatchObject({ failed: 2, skipped: 1, passed: 10 }));
  it("reads pytest", () => expect(countsOf(["FAILED tests/test_x.py::test_y - assert 1 == 2", "==== 1 failed, 12 passed in 0.31s ===="])).toEqual({ failed: 1, passed: 12, failing: ["tests/test_x.py::test_y - assert 1 == 2"] }));
  it("says nothing about output it doesn't know", () => expect(countsOf(["done"])).toEqual({}));
});

describe("fromHook", () => {
  const base = { session_id: "s1", cwd: "/tmp", tool_name: "Bash", tool_use_id: "toolu_1", duration_ms: 4000 };
  it("turns a passing test into a passed run", () => {
    const r = fromHook({ ...base, hook_event_name: "PostToolUse", tool_input: { command: "pnpm test", description: "Run the tests" }, tool_response: { stdout: "Tests  3 passed (3)", stderr: "", interrupted: false } }, undefined, 10_000);
    expect(r).toMatchObject({ kind: "unit", name: "Run the tests", status: "pass", exitCode: 0, output: "Tests  3 passed (3)", startedAt: 6000, endedAt: 10_000, meta: { session: "s1" } });
  });
  it("reads the exit code from a failure", () => {
    const r = fromHook({ ...base, hook_event_name: "PostToolUseFailure", tool_input: { command: "pnpm lint" }, error: "Exit code 2\nsrc/a.ts: error", is_interrupt: false });
    expect(r).toMatchObject({ kind: "lint", status: "fail", exitCode: 2, output: "src/a.ts: error" });
  });
  it("counts an interrupt as cancelled", () => expect(fromHook({ ...base, hook_event_name: "PostToolUseFailure", tool_input: { command: "pnpm test" }, error: "aborted", is_interrupt: true })?.status).toBe("cancelled"));
  it("leaves out other commands, other tools and background shells", () => {
    expect(fromHook({ ...base, hook_event_name: "PostToolUse", tool_input: { command: "ls" }, tool_response: { stdout: "" } })).toBeUndefined();
    expect(fromHook({ ...base, tool_name: "Read", hook_event_name: "PostToolUse", tool_input: { command: "pnpm test" } })).toBeUndefined();
    expect(fromHook({ ...base, hook_event_name: "PostToolUse", tool_input: { command: "pnpm test", run_in_background: true }, tool_response: { stdout: "" } })).toBeUndefined();
  });
  it("records the same tool call once", () => {
    const p = { ...base, tool_use_id: `toolu_${Date.now()}`, hook_event_name: "PostToolUse", tool_input: { command: `pnpm vitest run once-${Date.now()}` }, tool_response: { stdout: "ok" } };
    expect(recordHook(p)?.status).toBe("pass");
    expect(recordHook(p)).toBeUndefined();
  });
  it("leaves out a command that reported its own run", () => {
    const own = `pnpm run e2e flows/own-${Date.now()}.yaml`;
    startRun({ name: "ACME-12-own", kind: "e2e", command: own, cwd: "/tmp" }, "script");
    const p = { ...base, tool_use_id: `toolu_own_${Date.now()}`, hook_event_name: "PostToolUse", duration_ms: 1000, tool_input: { command: `RECORD_VIDEO=0 ./record.sh ACME-12-own ${own}` }, tool_response: { stdout: "ok" } };
    expect(recordHook(p)).toBeUndefined();
  });
});

describe("a run", () => {
  it("follows record_run.sh's events to the end", () => {
    const r = startRun({ name: "ACME-12-change-unit", kind: "proof", command: "pnpm run e2e x.yaml", cwd: "/tmp", meta: { udid: "X" } }, "script");
    expect(r).toMatchObject({ status: "running", ticket: "ACME-12", kind: "proof" });
    appendRun(r.id, { phase: "running" });
    appendRun(r.id, { lines: ["one", "\x1b[32mtwo\x1b[0m"], steps: ["Tap on id: x... COMPLETED"] });
    appendRun(r.id, { phase: "rendering" });
    appendRun(r.id, { progress: 0.5 });
    expect(getRun(r.id)?.meta).toMatchObject({ phase: "rendering", progress: 0.5, udid: "X" });
    mkdirSync(filesDir(r.id), { recursive: true });
    writeFileSync(join(filesDir(r.id), `${r.id}.mp4`), "video");
    appendRun(r.id, { result: { status: 0, file: `${r.id}.mp4`, macPath: "~/Downloads/x.mp4", size: "2M" } });
    appendRun(r.id, { phase: "done" });
    const done = getRun(r.id)!;
    expect(done).toMatchObject({ status: "pass", exitCode: 0, meta: { phase: "done", macPath: "~/Downloads/x.mp4", size: "2M" } });
    expect(done.artifacts).toEqual([{ name: `${r.id}.mp4`, path: `${r.id}/${r.id}.mp4`, type: "video" }]);
    expect(outputTail(r.id)).toEqual(["one", "two"]);
    expect(stepLines(r.id)).toEqual(["Tap on id: x... COMPLETED"]);
  });
  it("fails on a non-zero exit, and on a failed phase", () => {
    const a = startRun({ command: "pnpm test" }, "script");
    appendRun(a.id, { result: { status: 1 }, phase: "done" });
    expect(getRun(a.id)).toMatchObject({ status: "fail", exitCode: 1, kind: "unit" });
    const b = startRun({ name: "x" }, "script");
    appendRun(b.id, { phase: "failed", error: "render failed" });
    expect(getRun(b.id)).toMatchObject({ status: "fail", meta: { error: "render failed" } });
  });
  it("only keeps artifacts from where it ran", () => {
    const r = startRun({ name: "x", cwd: "/tmp" }, "script");
    appendRun(r.id, { artifacts: [{ path: "/etc/hostname" }] });
    expect(getRun(r.id)?.artifacts).toEqual([]);
  });
  it("records a finished one in one go, with counts from its output", () => {
    const r = recordRun({ command: "pnpm test", status: "fail", exitCode: 1, output: "Tests  2 failed | 3 passed (5)" }, "mcp");
    expect(r.summary).toMatchObject({ failed: 2, passed: 3 });
    expect(listRuns({ kind: "unit", status: "fail" }).some((x) => x.id === r.id)).toBe(true);
  });
  it("tells you about a failure unless it's recorded quietly", () => {
    const told = (id: string) => db.prepare("select count(*) n from events_log where link = ?").get(`/runs/${id}`) as { n: number };
    const loud = recordRun({ name: "ci", kind: "ci", status: "fail" }, "plugin:x");
    const quiet = recordRun({ name: "ci", kind: "ci", status: "fail", quiet: true }, "plugin:x");
    expect(told(loud.id).n).toBe(1);
    expect(told(quiet.id).n).toBe(0);
  });
  it("ignores an end for a run that isn't there", () => expect(finishRun("nope")).toBeUndefined());
});

describe("sweep", () => {
  it("drops old runs but keeps the sprint's", () => {
    const old = startRun({ name: "old", ticket: "OLD-1" }, "script");
    const kept = startRun({ name: "kept", ticket: "CUR-1" }, "script");
    db.prepare("update runs set started_at = ? where id in (?, ?)").run(Date.now() - 100 * 864e5, old.id, kept.id);
    writeFileSync(join(filesDir(old.id) + ".log"), "x");
    sweep(new Set(["CUR-1"]));
    expect(getRun(old.id)).toBeUndefined();
    expect(existsSync(filesDir(old.id) + ".log")).toBe(false);
    expect(getRun(kept.id)).toBeDefined();
  });
});

describe("screenLines", () => {
  it("turns tmux's scrollback into plain lines", () => {
    const out = "\x1b=\x1b(B\x1b[>c\x1b[>q\x1b]10;?\x1b\\\x1b]11;?\x1b\\\r\n\r\n\r\n\x1b(B\r\n\x1b[32mone\x1b[0m\r\ntwo\r\n\x1b(B\x1b>[exited]\r\n";
    expect(screenLines(out)).toEqual(["one", "two"]);
  });
});

describe("failed runs' videos", () => {
  const failed = (name: string, at: number) => {
    const r = startRun({ name, kind: "proof", command: "pnpm run e2e x.yaml", cwd: "/tmp", startedAt: at } as never, "script");
    mkdirSync(filesDir(r.id), { recursive: true });
    writeFileSync(join(filesDir(r.id), `${r.id}.mp4`), "video");
    appendRun(r.id, { result: { status: 1, file: `${r.id}.mp4` } });
    return finishRun(r.id, { status: "fail", endedAt: at })!;
  };
  it("go after the hours given, and the run stays", () => {
    const now = Date.now();
    const old = failed(`ACME-1-old-${now}`, now - 30 * 3600_000);
    const fresh = failed(`ACME-1-fresh-${now}`, now - 3600_000);
    dropFailedVideos(24, now);
    expect(getRun(old.id)?.artifacts).toEqual([]);
    expect(getRun(old.id)?.meta.videoDropped).toBeTruthy();
    expect(existsSync(join(filesDir(old.id), `${old.id}.mp4`))).toBe(false);
    expect(getRun(fresh.id)?.artifacts).toHaveLength(1);
  });
  it("go once a later run of the same thing passes, and 0 hours keeps them", () => {
    const now = Date.now();
    const name = `ACME-2-flow-${now}`;
    const r = failed(name, now - 60_000);
    dropFailedVideos(0, now);
    expect(getRun(r.id)?.artifacts).toHaveLength(1);
    recordRun({ name, kind: "proof", command: "pnpm run e2e x.yaml", cwd: "/tmp", status: "pass", exitCode: 0 }, "script");
    dropFailedVideos(24, now);
    expect(getRun(r.id)?.artifacts).toEqual([]);
  });
});
