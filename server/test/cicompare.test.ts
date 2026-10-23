import { describe, expect, it } from "vitest";
import { comparePrompt, jobWord, localCommand } from "../src/cicompare.ts";

const scripts = [
  { rel: ".", name: "lint", runner: "pnpm" },
  { rel: ".", name: "test", runner: "pnpm" },
  { rel: "apps/web", name: "e2e", runner: "pnpm" },
];

describe("jobWord", () => {
  it("drops the matrix and the workflow name", () => {
    expect(jobWord("ci / Lint (18.x)")).toBe("lint");
  });
});

describe("localCommand", () => {
  it("takes the settings line first, with * in the name", () => {
    expect(localCommand("unit-tests (api)", ["unit-tests* = make test"], scripts, "pnpm verify")).toEqual({ command: "make test", from: "settings" });
  });

  it("then a root script named like the job, plural or not", () => {
    expect(localCommand("ci / lint", [], scripts, "")).toEqual({ command: "pnpm run lint", from: "script" });
    expect(localCommand("tests", [], scripts, "")).toEqual({ command: "pnpm run test", from: "script" });
  });

  it("then the verify command, and nothing when there's none", () => {
    expect(localCommand("e2e", [], scripts, "pnpm verify")).toEqual({ command: "pnpm verify", from: "verify" });
    expect(localCommand("e2e", ["no equals sign here"], scripts, "")).toBeUndefined();
  });
});

describe("comparePrompt", () => {
  const c = { worktree: "/w", pr: 5, check: "coverage", ciTail: "99.1% < 100%", command: "pnpm test", localDirty: false, env: ["node v22"], state: "done" as const, code: 0, localTail: "100%", at: 0 };

  it("says when both ran on the same commit", () => {
    expect(comparePrompt({ ...c, ciSha: "abc", localSha: "abc" })).toContain("Both ran on abc");
  });

  it("warns when the code differs as well", () => {
    expect(comparePrompt({ ...c, ciSha: "abc", localSha: "def", localDirty: true })).toContain("part of the difference may just be the code");
  });
});
