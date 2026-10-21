import { describe, expect, it } from "vitest";
import type { Entry } from "@cockpit/shared";
import { columnOf } from "../src/board.ts";
import { alertKey, looksStuck } from "../src/stuck.ts";

const pr = (over: object = {}) => ({ state: "OPEN", checks: "pass" as const, isDraft: false, reviewDecision: undefined as string | undefined, mergeable: "MERGEABLE", ...over });

describe("columnOf", () => {
  it("puts a session with a question in Needs you, even when its PR is open or merged", () => {
    expect(columnOf({ session: { status: "waiting", waitingFor: "input needed", updatedAt: 0 } })).toEqual({ column: "needs", reason: "Claude needs your input" });
    expect(columnOf({ session: { status: "waiting", updatedAt: 0 }, pr: pr() }).column).toBe("needs");
    expect(columnOf({ session: { status: "waiting", updatedAt: 0 }, pr: { ...pr(), state: "MERGED" } }).column).toBe("needs");
  });
  it("leaves a session that only finished its turn out of Needs you", () => {
    expect(columnOf({ session: { status: "idle", updatedAt: 0 } }).column).toBe("quiet");
    expect(columnOf({ session: { status: "idle", updatedAt: 0 }, task: { status: "done" } }).column).toBe("needs");
  });
  it("keeps a busy session in Working even with failing checks", () => {
    expect(columnOf({ session: { status: "busy", updatedAt: 0 }, pr: pr({ checks: "fail" }) }).column).toBe("working");
  });
  it("sends failing checks to Needs you, or Working with autopilot on", () => {
    expect(columnOf({ pr: pr({ checks: "fail" }) })).toEqual({ column: "needs", reason: "Checks are failing" });
    expect(columnOf({ pr: pr({ checks: "fail" }), autopilot: { on: true, gaveUp: false } }).column).toBe("working");
    expect(columnOf({ pr: pr({ checks: "fail" }), autopilot: { on: true, gaveUp: true } }).column).toBe("needs");
  });
  it("waits for reviewers, then is ready once approved", () => {
    expect(columnOf({ session: { status: "idle", updatedAt: 0 }, pr: pr() }).column).toBe("review");
    expect(columnOf({ pr: pr({ reviewDecision: "APPROVED" }) }).column).toBe("ready");
    expect(columnOf({ pr: pr({ reviewDecision: "APPROVED", checks: "pending" }) }).column).toBe("review");
    expect(columnOf({ pr: { ...pr(), state: "MERGED" } }).column).toBe("ready");
  });
  it("flags conflicts, failed local checks and stuck sessions", () => {
    expect(columnOf({ pr: pr({ mergeable: "CONFLICTING" }) }).reason).toBe("Merge conflict");
    expect(columnOf({ verify: { state: "fail" } }).column).toBe("needs");
    expect(columnOf({ session: { status: "busy", updatedAt: 0 }, stuck: "No progress for 25 minutes" })).toEqual({ column: "needs", reason: "No progress for 25 minutes" });
  });
  it("queues tasks until they have a session", () => {
    expect(columnOf({ task: { status: "queued" } }).column).toBe("queued");
    expect(columnOf({ task: { status: "running" }, session: { status: "busy", updatedAt: 0 } }).column).toBe("working");
  });
  it("leaves a worktree with nothing going on as quiet", () => {
    expect(columnOf({}).column).toBe("quiet");
  });
});

const tool = (name: string, input: unknown, i: number): Entry => ({ kind: "tool", id: `t${i}`, ts: "", toolUseId: `u${i}`, name, input });
const result = (isError: boolean, i: number): Entry => ({ kind: "tool_result", id: `r${i}`, ts: "", toolUseId: `u${i}`, text: "", isError });

describe("looksStuck", () => {
  it("alerts once per kind of problem, not once per minute or count", () => {
    expect(alertKey("s1", "No progress for 21 minutes")).toBe(alertKey("s1", "No progress for 22 minutes"));
    expect(alertKey("s1", "3 tool calls failed in a row")).not.toBe(alertKey("s1", "No progress for 21 minutes"));
    expect(alertKey("s1", "No progress for 21 minutes")).not.toBe(alertKey("s2", "No progress for 21 minutes"));
  });

  it("notices the same call over and over", () => {
    const entries = [0, 1, 2, 3].flatMap((i) => [tool("Bash", { command: "pnpm test" }, i), result(false, i)]);
    expect(looksStuck(entries)).toMatch(/Bash the same way 4 times/);
  });
  it("notices failures in a row", () => {
    const entries = [0, 1, 2].flatMap((i) => [tool("Read", { file_path: `f${i}` }, i), result(true, i)]);
    expect(looksStuck(entries)).toMatch(/failed in a row/);
  });
  it("leaves normal work alone", () => {
    const entries = [0, 1, 2, 3].flatMap((i) => [tool("Read", { file_path: `f${i}` }, i), result(i === 1, i)]);
    expect(looksStuck(entries)).toBeUndefined();
  });
});

import { decide, signatureOf } from "../src/autopilot.ts";

describe("autopilot", () => {
  const red = { state: "OPEN", checks: "fail" as const, reviewDecision: undefined, headSha: "abc" };
  it("acts once per failure, then waits for something new", () => {
    const sig = signatureOf(red, 0);
    expect(decide(red, { attempts: 0, signature: null }, sig, 3)).toEqual({ act: "fix", kind: "checks" });
    expect(decide(red, { attempts: 1, signature: sig }, sig, 3).act).toBe("none");
    const again = signatureOf({ ...red, headSha: "def" }, 0);
    expect(decide({ ...red, headSha: "def" }, { attempts: 1, signature: sig }, again, 3).act).toBe("fix");
  });
  it("gives up after the limit", () => {
    expect(decide(red, { attempts: 3, signature: "old" }, signatureOf(red, 0), 3).act).toBe("give-up");
  });
  it("answers requested changes and notices green", () => {
    const changes = { state: "OPEN", checks: "pass" as const, reviewDecision: "CHANGES_REQUESTED", headSha: "a" };
    expect(decide(changes, { attempts: 0, signature: null }, signatureOf(changes, 2), 3)).toEqual({ act: "fix", kind: "comments" });
    const green = { state: "OPEN", checks: "pass" as const, reviewDecision: undefined, headSha: "b" };
    expect(decide(green, { attempts: 1, signature: "x" }, signatureOf(green, 0), 3).act).toBe("green");
    expect(decide(green, { attempts: 0, signature: null }, signatureOf(green, 0), 3).act).toBe("none");
  });
});
