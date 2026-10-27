import { describe, expect, it } from "vitest";
import type { PullRequest } from "@cockpit/shared";
import { branchAt, branchMoves, prFor } from "../src/runPr.ts";

const pr = (n: number, branch: string, state: string): PullRequest => ({ number: n, title: "", url: `u/${n}`, branch, state, isDraft: false, createdAt: "" });

describe("the PR a run ran against", () => {
  it("takes a branch's open PR, else the merged one", () => {
    const prs = [pr(1, "a", "CLOSED"), pr(2, "a", "MERGED"), pr(3, "b", "OPEN"), pr(4, "a", "OPEN")];
    expect(prFor("a", prs)?.number).toBe(4);
    expect(prFor("a", prs.slice(0, 2))?.number).toBe(2);
    expect(prFor("c", prs)).toBeUndefined();
    expect(prFor(undefined, prs)).toBeUndefined();
  });

  it("reads which branch a worktree had checked out at a moment from its reflog", () => {
    const reflog = [
      "HEAD@{1700000300}\tcommit: tweak colours",
      "HEAD@{1700000200}\tcheckout: moving from feat/ds/ux to feat/ds/colors",
      "HEAD@{1700000150}\trebase (finish): returning to refs/heads/feat/ds/ux",
      "HEAD@{1700000100}\tcheckout: moving from main to 0123456789abcdef0123456789abcdef01234567",
      "HEAD@{1700000000}\tcheckout: moving from main to feat/ds/ux",
    ].join("\n");
    const moves = branchMoves(reflog);
    expect(moves.map((m) => m.branch)).toEqual(["feat/ds/ux", "", "feat/ds/ux", "feat/ds/colors"]);
    expect(branchAt(moves, 1_699_999_999_000)).toBeUndefined();
    expect(branchAt(moves, 1_700_000_050_000)).toBe("feat/ds/ux");
    // detached in between
    expect(branchAt(moves, 1_700_000_120_000)).toBeUndefined();
    expect(branchAt(moves, 1_700_000_160_000)).toBe("feat/ds/ux");
    expect(branchAt(moves, 1_700_000_400_000)).toBe("feat/ds/colors");
  });
});
