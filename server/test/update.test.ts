import { describe, expect, it } from "vitest";
import { parseCommit } from "../src/update.ts";

describe("what's new", () => {
  it("takes a conventional commit apart, with its body's first paragraph", () => {
    const c = parseCommit(["abc123", "1793000000", "feat(work): the ticket pipeline opens Work", "Each ticket on its road.\nWith the next step.\n\nAlso: more."].join("\x1f"));
    expect(c).toEqual({ sha: "abc123", at: 1_793_000_000_000, type: "feat", scope: "work", subject: "the ticket pipeline opens Work", detail: "Each ticket on its road. With the next step." });
    expect(parseCommit(["d", "1", "fix!: breaking thing", ""].join("\x1f"))).toMatchObject({ type: "fix", scope: undefined, subject: "breaking thing", detail: undefined });
    expect(parseCommit(["e", "1", "Merge branch main", ""].join("\x1f"))).toMatchObject({ type: "other", subject: "Merge branch main" });
    expect(parseCommit("")).toBeUndefined();
  });
});
