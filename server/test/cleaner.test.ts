import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Worktree } from "@cockpit/shared";
import { judge } from "../src/cleaner.ts";
import { config } from "../src/config.ts";
import { removeStep, tidyParent } from "../src/worktrees.ts";

const now = Date.parse("2026-10-20T12:00:00Z");
const wt = (extra: Partial<Worktree> = {}): Worktree => ({ path: "/w/ACME-1/repo", name: "ACME-1", branch: "feat/ACME-1/x", head: "abc", main: false, ticket: "ACME-1", lastCommitAt: now - 864e5, ...extra });
const facts = { missing: false, orphaned: false, busy: false, termOpen: false, epic: false };

describe("worktree cleaner rules", () => {
  it("keeps a worktree with nothing pointing at it being done", () => {
    expect(judge(wt(), facts, now).verdict).toBe("keep");
  });

  it("marks a merged PR with a clean tree as safe", () => {
    const c = judge(wt(), { ...facts, pr: { number: 7, state: "MERGED", url: "" } }, now);
    expect([c.verdict, c.reasons]).toEqual(["safe", ["PR #7 merged"]]);
  });

  it("asks to look first when work only lives there", () => {
    const c = judge(wt({ dirty: 2, ahead: 1 }), { ...facts, ticket: { key: "ACME-1", status: "Done", statusCategory: "done" } }, now);
    expect(c.verdict).toBe("check");
    expect(c.blockers).toEqual(["2 uncommitted files", "1 commit not pushed"]);
  });

  it("counts a month without commits, but not while a PR is open", () => {
    const old = wt({ lastCommitAt: now - 40 * 864e5 });
    expect(judge(old, facts, now).reasons).toEqual(["no commits for 40 days"]);
    expect(judge(old, { ...facts, pr: { number: 3, state: "OPEN", url: "" } }, now).verdict).toBe("keep");
  });

  it("holds back anything busy or an unfinished epic", () => {
    const merged = { ...facts, pr: { number: 1, state: "MERGED", url: "" } };
    expect(judge(wt(), { ...merged, busy: true }, now).blockers).toContain("Claude is running in it");
    expect(judge(wt(), { ...merged, termOpen: true }, now).blockers).toContain("a terminal is open in it");
    expect(judge(wt(), { ...merged, epic: true }, now).blockers).toContain("epic still in progress");
    expect(judge(wt({ branch: undefined }), { ...merged, orphaned: true }, now).blockers).toContain("detached, its commit is on no branch");
  });

  it("lets a folder that's already gone go, whatever git thought of it", () => {
    const c = judge(wt({ dirty: 5 }), { ...facts, missing: true }, now);
    expect([c.verdict, c.blockers]).toEqual(["safe", []]);
  });
});

describe("worktree removal", () => {
  it("falls back to docker for files containers left behind, and tidies the parent", () => {
    const step = removeStep(`${config.repo.worktreesDir}/ACME-1/${config.repo.name}`);
    expect(step).toContain("docker run --rm -v");
    expect(step).toContain("could not remove ACME-1");
    expect(step).toContain(`rmdir "${config.repo.worktreesDir}/ACME-1" 2>/dev/null`);
  });

  it("removes leftover folders with rm, not the git command", () => {
    expect(removeStep("/w/old", true)).toContain('rm -rf "/w/old"');
  });

  it("drops a parent folder left with only workspace files, and keeps one with anything else", () => {
    const root = mkdtempSync(join(tmpdir(), "cockpit-tidy-"));
    const only = join(root, "ACME-1");
    const more = join(root, "ACME-2");
    mkdirSync(only);
    mkdirSync(more);
    writeFileSync(join(only, "ACME-1.code-workspace"), "{}");
    writeFileSync(join(more, "ACME-2.code-workspace"), "{}");
    writeFileSync(join(more, "notes.md"), "keep me");
    execFileSync("bash", ["-c", `${tidyParent(only)} ; ${tidyParent(more)} ; ${tidyParent(join(root, "gone"))} ; true`]);
    expect(existsSync(only)).toBe(false);
    expect(readdirSync(more).sort()).toEqual(["ACME-2.code-workspace", "notes.md"]);
    rmSync(root, { recursive: true });
  });
});

import { errorTail } from "../../plugins/github/server.ts";

describe("failed job logs", () => {
  it("keeps the lines up to the last error, without gh's prefix or colours", () => {
    const log = ["job\tstep\t2026-10-20T16:56:01.1Z setup", "job\tstep\t2026-10-20T16:56:01.2Z \x1b[31mboom\x1b[0m", "job\tstep\t2026-10-20T16:56:01.3Z ##[error]Process completed with exit code 1.", "job\tstep\t2026-10-20T16:56:02.0Z Cleaning up orphan processes"].join("\n");
    expect(errorTail(log)).toBe("setup\nboom\n##[error]Process completed with exit code 1.");
  });
});

import { toMatch } from "../src/claude/search.ts";

describe("session search query", () => {
  it("needs every word and lets the last one be a prefix", () => {
    expect(toMatch("worktree clean")).toBe('"worktree" "clean"*');
    expect(toMatch(`  "AND" OR ( `)).toBe('"AND" "OR"*');
    expect(toMatch("!!")).toBe("");
  });
});
