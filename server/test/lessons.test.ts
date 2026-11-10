import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.ts";
import { byWords, dismissLesson, lessonsPrompt, parseRules, recompute, reviewLessons, saveComments } from "../src/lessons.ts";

beforeEach(() => {
  db.exec("delete from review_comments; delete from review_lessons; delete from cache where key = 'review-lessons:meta'");
  db.prepare("delete from settings where key in ('quick', 'lessons')").run();
});

describe("saveComments", () => {
  it("keeps reviewers' comments once, without your replies or bots", () => {
    const list = [
      { path: "src/a.ts", line: 3, author: "alex", body: "This can be null" },
      { path: "src/a.ts", line: 3, author: "me", body: "Fixed", mine: true },
      { author: "ci[bot]", body: "Coverage went down" },
    ];
    expect(saveComments("owner/repo", 1, list)).toBe(1);
    expect(saveComments("owner/repo", 1, list)).toBe(0);
    // your own review's comments are all yours
    expect(saveComments("owner/repo", 2, [{ path: "x.ts", body: "Missing test", mine: true }], true)).toBe(1);
    expect(db.prepare("select pr, mine from review_comments order by id").all()).toEqual([
      { pr: 1, mine: 0 },
      { pr: 2, mine: 1 },
    ]);
  });
});

describe("parseRules", () => {
  it("reads a rule a line with the comments it came from, dropping one-offs and numbers out of range", () => {
    const found = parseRules('1. "Handle the error state of requests" [1, 3, 3]\n- Add tests (e.g. for nulls) [2, 4, 99]\nAlways be kind [2]\nSome chatter', 4);
    expect(found).toEqual([
      { rule: "Handle the error state of requests", ids: [0, 2] },
      { rule: "Add tests (e.g. for nulls)", ids: [1, 3] },
    ]);
  });
});

describe("byWords", () => {
  it("groups comments by a word that comes up on more than one PR", () => {
    const rows = [
      { pr: 1, body: "Handle the loading state" },
      { pr: 2, body: "No loading spinner here?" },
      { pr: 2, body: "Loading flickers" },
      { pr: 3, body: "Typo in the name" },
    ];
    expect(byWords(rows)).toEqual([{ rule: 'Comments about "loading"', ids: [0, 1, 2] }]);
  });
});

describe("recompute", () => {
  it("falls back to common words without a quick model, says so, and keeps a dismissed lesson dismissed", async () => {
    saveComments("owner/repo", 1, [{ path: "a.ts", body: "Add a translation for this label" }]);
    saveComments("owner/repo", 2, [{ path: "b.ts", body: "This translation key is missing" }]);
    saveComments("owner/repo", 3, [{ path: "c.ts", body: "Translation missing in French" }]);
    await recompute();
    let r = reviewLessons();
    expect(r.method).toBe("words");
    expect(r.note).toMatch(/No quick model/);
    expect(r.lessons).toMatchObject([{ rule: 'Comments about "translation"', count: 3, prs: 3, dismissed: false }]);
    expect(r.prompt).toContain("Before opening the PR, check your diff against these points reviewers raised on recent PRs:");

    dismissLesson(r.lessons[0].id);
    await recompute();
    r = reviewLessons();
    expect(r.lessons).toMatchObject([{ dismissed: true }]);
    expect(r.prompt).toBe("");
  });

  it("says nothing in the prompt when turned off", async () => {
    for (const n of [1, 2, 3]) saveComments("owner/repo", n, [{ body: `Rename this variable ${n}` }]);
    await recompute();
    db.prepare("insert or replace into settings (key, value) values ('lessons', ?)").run(JSON.stringify({ on: false, count: 5 }));
    expect(reviewLessons().lessons.length).toBe(1);
    expect(reviewLessons().prompt).toBe("");
  });
});

describe("lessonsPrompt", () => {
  it("lists the top active ones with a count and an example", () => {
    const l = (rule: string, dismissed = false) => ({ id: rule, rule, count: 3, prs: 2, examples: ["like this"], dismissed });
    const p = lessonsPrompt([l("One", true), l("Two"), l("Three"), l("Four")], 2);
    expect(p).toContain('- Two (raised 3 times, e.g. "like this")\n- Three');
    expect(p).not.toContain("One");
    expect(p).not.toContain("Four");
  });
});
