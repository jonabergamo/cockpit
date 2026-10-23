import { describe, expect, it } from "vitest";
import { againNote } from "../src/reviews.ts";

const last = {
  commit: "aaaaaaaaaaaaaaaa",
  head: "bbbbbbbbbbbbbbbb",
  at: "2026-10-20T10:00:00Z",
  state: "CHANGES_REQUESTED",
  url: "https://github.com/acme/app/pull/7#pullrequestreview-1",
  commits: 2,
  files: 1,
  rewritten: false,
  comments: [{ path: "src/a.ts", line: 4, author: "me", body: "This can be\nnull" }],
};

describe("againNote", () => {
  it("narrows the review to the diff since the reviewed commit and lists the earlier comments", () => {
    const note = againNote(last);
    expect(note).toContain("git diff aaaaaaaaaaaa..bbbbbbbbbbbb");
    expect(note).toContain("2 commits touching 1 file.");
    expect(note).toContain("changes requested, 2026-10-20");
    expect(note).toContain("1. src/a.ts:4: This can be null");
  });

  it("says when a force-push dropped the reviewed commit", () => {
    const note = againNote({ ...last, rewritten: true, comments: [] });
    expect(note).toContain("rewritten");
    expect(note).not.toContain("git diff");
    expect(note).not.toContain("earlier comments");
  });
});
