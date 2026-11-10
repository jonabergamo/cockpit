import { beforeEach, describe, expect, it } from "vitest";
import "../src/claude/search.ts";
import { db } from "../src/db.ts";
import { chipsFrom, forgetFrequent, frequentHere, groupReplies, isReply, parseOrder, rankReplies } from "../src/replies.ts";

const put = db.prepare("insert into session_text (text, session_id, entry_id, ts, role) values (?, 's1', ?, ?, ?)");

beforeEach(() => {
  db.exec("delete from session_text");
  db.prepare("delete from settings where key in ('quick', 'replies')").run();
  forgetFrequent();
});

describe("isReply", () => {
  it("leaves out commands, markers, pasted things and menu numbers", () => {
    for (const s of ["/compact", "[Request interrupted by user]", "[Image #2]", "<command-name>x</command-name>", "!ls", "see https://example.com", "~/Downloads/a.webm", "1", "ok\nand more", "x".repeat(90), " . "])
      expect(isReply(s), s).toBe(false);
    for (const s of ["go ahead", "Open the PR.", "run fix:all and the tests"]) expect(isReply(s), s).toBe(true);
  });
});

describe("groupReplies", () => {
  it("groups by the lowercased text without trailing punctuation, shown as you wrote it most", () => {
    const out = groupReplies(["Open the PR", "open the PR.", "Open the PR!", "go ahead", "Go ahead", "once only", "/compact", "/compact"]);
    expect(out).toEqual([
      { text: "Open the PR", count: 3 },
      { text: "go ahead", count: 2 },
    ]);
  });
});

describe("frequentHere", () => {
  it("reads your short prompts of the last 30 days and not the agent's", () => {
    const now = Date.parse("2026-03-31T12:00:00Z");
    put.run("commit it", "a", "2026-03-30T10:00:00Z", "user");
    put.run("commit it", "b", "2026-03-29T10:00:00Z", "user");
    put.run("commit it", "c", "2026-01-01T10:00:00Z", "user");
    put.run("commit it", "d", "2026-03-30T10:00:00Z", "assistant");
    expect(frequentHere(now)).toEqual([{ text: "commit it", count: 2 }]);
  });
});

describe("chipsFrom", () => {
  it("adds up machines, puts pins first and leaves hidden ones out", () => {
    const lists = [
      [
        { text: "go ahead", count: 5 },
        { text: "push", count: 9 },
      ],
      [
        { text: "go ahead", count: 2 },
        { text: "stop", count: 4 },
      ],
    ];
    expect(chipsFrom(lists, { on: true, pinned: ["open the PR", "stop"], hidden: ["PUSH"] })).toEqual([
      { text: "open the PR", count: 0, pinned: true },
      { text: "stop", count: 4, pinned: true },
      { text: "go ahead", count: 7 },
    ]);
  });
});

describe("ranking", () => {
  it("reads the model's numbers, keeping the ones it left out", () => {
    expect(parseOrder("3, 1", ["a", "b", "c"])).toEqual(["c", "a", "b"]);
    expect(parseOrder("2, 2, 9", ["a", "b"])).toEqual(["b", "a"]);
    expect(parseOrder("none", ["a", "b"])).toBeUndefined();
  });

  it("leaves the order alone without a local model", async () => {
    expect(await rankReplies("Shall I open the PR?", ["go ahead", "open the PR"])).toBeUndefined();
  });
});
