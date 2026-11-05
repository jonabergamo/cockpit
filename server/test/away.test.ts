import { describe, expect, it } from "vitest";
import type { Entry } from "@cockpit/shared";
import { firstWords, tally } from "../src/away.ts";

const at = (min: number) => new Date(Date.UTC(2026, 10, 5, 10, min)).toISOString();
const since = Date.parse(at(30));
const tool = (min: number, name: string, input: unknown): Entry => ({ kind: "tool", id: `t${min}`, ts: at(min), toolUseId: `u${min}`, name, input });
const said = (min: number, text: string): Entry => ({ kind: "assistant", id: `a${min}`, ts: at(min), text });

describe("tally", () => {
  it("adds up what it did after you left, nothing from before", () => {
    const t = tally(
      [
        tool(10, "Edit", { file_path: "/r/old.ts" }),
        said(20, "Before you left."),
        tool(31, "Edit", { file_path: "/r/app.ts" }),
        tool(32, "Write", { file_path: "/r/app.ts" }),
        tool(33, "Write", { file_path: "/r/new.ts" }),
        tool(34, "Bash", { command: "pnpm test" }),
        tool(35, "Bash", { command: 'git add -A && git commit -m "feat(app): export button"' }),
        said(36, "Done: the export button works and its test passes."),
      ],
      since,
    );
    expect(t).toEqual({ any: true, edited: ["/r/app.ts", "/r/new.ts"], commands: 2, commits: ["feat(app): export button"], last: "Done: the export button works and its test passes." });
  });

  it("says nothing happened when nothing did", () => {
    expect(tally([said(10, "Earlier.")], since)).toMatchObject({ any: false, edited: [], commands: 0, commits: [] });
  });
});

describe("firstWords", () => {
  it("keeps the first sentence of what it said last, without headings", () => {
    expect(firstWords("## Summary\n\nThe export works. Next I'll add the docs.")).toBe("The export works.");
    expect(firstWords("x".repeat(300))).toHaveLength(201);
    expect(firstWords(undefined)).toBeUndefined();
  });
});
