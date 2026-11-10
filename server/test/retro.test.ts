import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.ts";
import "../src/claude/search.ts";
import { appendLearned, corrections, dismissTheme, fixLoops, isCorrection, parseThemes, recompute, retro, type RunRow } from "../src/retro.ts";

beforeEach(() => {
  db.exec("delete from session_text; delete from retro_themes; delete from cache where key = 'retro:meta'");
  db.prepare("delete from settings where key in ('quick', 'retro')").run();
});

describe("isCorrection", () => {
  it("knows a correction when it sees one", () => {
    for (const t of [
      "no, use the existing helper",
      "No.",
      "don't add a new dependency for that",
      "Please don't touch the lockfile",
      "stop, that's the wrong file",
      "stop adding comments everywhere",
      "that's wrong, the column is nullable",
      "you forgot the migration",
      "I said the server, not the web app",
      "it's failing again!",
      "why did you delete the test?",
      "not what I asked for",
      "revert that",
    ])
      expect(isCorrection(t), t).toBe(true);
  });
  it("leaves prompts, chores and pasted text alone", () => {
    for (const t of [
      "try again now",
      "stop the dev server",
      "add a retry when the request fails",
      "no needed then, carry on with the next step",
      "don't need to open the PR yet",
      "[Request interrupted by user]",
      "<command-name>/clear</command-name>",
      'Alex Doe — 10:02\n<pasted_content id="1">no we dont deploy today</pasted_content>',
      `no, ${"long text ".repeat(80)}`,
    ])
      expect(isCorrection(t), t).toBe(false);
  });
});

const put = db.prepare("insert into session_text (text, session_id, entry_id, ts, role) values (?, ?, ?, ?, ?)");
const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

describe("corrections", () => {
  it("finds your corrections with the answer before them, counts interrupts and skips repeated automation prompts", () => {
    put.run("Add a button", "s1", "e1", at(30), "user");
    put.run("Done.\nI added the button and pushed it.", "s1", "e2", at(29.9), "assistant");
    put.run("Other session talking", "s2", "x1", at(29.8), "assistant");
    put.run("you forgot to run the tests", "s1", "e3", at(29.7), "user");
    put.run("[Request interrupted by user for tool use]", "s1", "e4", at(29), "user");
    for (let i = 0; i < 3; i++) put.run("Don't reply, just look at this screenshot and tell me what's on it please", `a${i}`, "e", at(20), "user");
    // older than the week
    put.run("no, wrong again", "s3", "e1", at(24 * 9), "user");
    const r = corrections(Date.now() - 7 * 864e5);
    expect(r.interrupts).toBe(1);
    expect(r.list).toEqual([{ key: "s1:e3", session: "s1", text: "you forgot to run the tests", before: "I added the button and pushed it." }]);
  });
});

const runRow = (id: string, status: string, started: number, o: Partial<RunRow> = {}): RunRow => ({ id, kind: "typecheck", name: "Typecheck", status, session: "s1", started, ...o });

describe("fixLoops", () => {
  it("finds a check that failed 3 or more times in a row before it passed in one session", () => {
    const runs = [
      runRow("1", "fail", 1),
      runRow("2", "fail", 2),
      // another session's failures don't add to this one's
      runRow("x", "fail", 2, { session: "s2" }),
      runRow("3", "fail", 3),
      runRow("4", "pass", 4),
      // twice is not a loop
      runRow("5", "fail", 5),
      runRow("6", "fail", 6),
      runRow("7", "pass", 7),
      // an e2e flow counts by its name
      runRow("e1", "fail", 1, { kind: "e2e", name: "login" }),
      runRow("e2", "fail", 2, { kind: "e2e", name: "checkout" }),
      runRow("e3", "fail", 3, { kind: "e2e", name: "login" }),
      runRow("e4", "pass", 4, { kind: "e2e", name: "login" }),
    ];
    expect(fixLoops(runs)).toEqual([{ session: "s1", check: "typecheck", label: "Typecheck", fails: 3, runs: ["1", "2", "3", "4"], cwd: undefined }]);
    expect(fixLoops(runs, 2).map((l) => l.check)).toEqual(["typecheck", "e2e:login", "typecheck"]);
  });
  it("needs a pass to call it a loop", () => {
    expect(fixLoops([runRow("1", "fail", 1), runRow("2", "fail", 2), runRow("3", "fail", 3)])).toEqual([]);
  });
});

describe("appendLearned", () => {
  it("makes the heading at the end when there's none", () => {
    expect(appendLearned("# Rules\n\n- Be terse\n", "Run the tests first")).toBe("# Rules\n\n- Be terse\n\n## Learned\n\n- Run the tests first\n");
    expect(appendLearned("", "Run the tests first")).toBe("## Learned\n\n- Run the tests first\n");
  });
  it("adds to the end of the section, before the next heading, and not twice", () => {
    const md = "# Rules\n\n## Learned\n\n- One\n\n## Style\n\n- Two\n";
    const out = appendLearned(md, "- Three");
    expect(out).toBe("# Rules\n\n## Learned\n\n- One\n- Three\n\n## Style\n\n- Two\n");
    expect(appendLearned(out!, "Three")).toBeUndefined();
    expect(appendLearned("## Learned", "One")).toBe("## Learned\n\n- One\n");
    expect(appendLearned("## Learned\n\n- One\n", "Two")).toBe("## Learned\n\n- One\n- Two\n");
  });
});

describe("parseThemes", () => {
  it("reads a title, a rule and the corrections it comes from", () => {
    expect(parseThemes("1. Claims done untested :: Run the tests before saying it's done [1, 3, 3]\nOne-off :: Do x [2]\nchatter", 3)).toEqual([
      { title: "Claims done untested", rule: "Run the tests before saying it's done", ids: [0, 2] },
    ]);
  });
});

describe("recompute", () => {
  it("groups by shared words without a quick model, says so, and keeps a dismissed theme dismissed", async () => {
    put.run("no, the migration goes in the server folder", "s1", "e1", at(5), "user");
    put.run("you forgot the migration again!", "s2", "e1", at(4), "user");
    put.run("I said the migration should be idempotent", "s3", "e1", at(3), "user");
    await recompute();
    let r = retro();
    expect(r.method).toBe("words");
    expect(r.note).toMatch(/No quick model/);
    expect(r.corrections).toBe(3);
    expect(r.themes).toMatchObject([{ kind: "correction", title: "Corrections about “migration”", count: 3, state: "open" }]);
    expect(r.themes[0].sessions.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    dismissTheme(r.themes[0].id);
    await recompute();
    r = retro();
    expect(r.themes.map((t) => t.state)).toEqual(["dismissed"]);
  });
  it("shows nothing while turned off", () => {
    db.prepare("insert or replace into settings (key, value) values ('retro', ?)").run(JSON.stringify({ on: false }));
    expect(retro()).toMatchObject({ on: false, themes: [] });
  });
});
