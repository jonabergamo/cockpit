import { describe, expect, it } from "vitest";
import { catchUpPrompt, nextState, stackedNote } from "../src/stacked.ts";

describe("nextState", () => {
  const row = { state: "open" as const, seen_sha: "aaa" };

  it("marks new commits on their PR", () => {
    expect(nextState(row, { state: "OPEN", headRefOid: "bbb" })).toEqual({ state: "moved", seen: "bbb" });
  });

  it("stays quiet while nothing changed", () => {
    expect(nextState(row, { state: "OPEN", headRefOid: "aaa" })).toBeUndefined();
  });

  it("notices a merge once, keeping the last commit seen", () => {
    expect(nextState(row, { state: "MERGED", headRefOid: "ccc" })).toEqual({ state: "merged", seen: "aaa" });
    expect(nextState({ ...row, state: "merged" }, { state: "MERGED" })).toBeUndefined();
  });

  it("stops following once the work moved onto the target", () => {
    expect(nextState({ ...row, state: "gone" }, { state: "OPEN", headRefOid: "zzz" })).toBeUndefined();
  });
});

describe("catchUpPrompt", () => {
  const s = { pr: 12, branch: "feat/their-thing", target: "staging", base_sha: "1111111111111111", seen_sha: "2222222222222222" };

  it("rebases only your commits onto their new head", () => {
    expect(catchUpPrompt({ ...s, state: "moved" })).toContain("git rebase --onto origin/feat/their-thing 111111111111");
  });

  it("moves the work onto their target after a merge and retargets the PR", () => {
    const p = catchUpPrompt({ ...s, state: "merged" });
    expect(p).toContain("git rebase --onto origin/staging 222222222222");
    expect(p).toContain("gh pr edit --base staging");
  });
});

it("tells the task's Claude which branch to target", () => {
  expect(stackedNote({ n: 12, title: "Their thing", author: "ana", branch: "feat/their-thing" })).toContain("--base feat/their-thing");
});
