import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.ts";
import { getSettings, moveHidden, readRow, writeRow } from "../src/settings.ts";

const before = (hidden?: string[]) => {
  db.prepare("delete from settings where key in ('hidden', 'navVersion')").run();
  if (hidden) writeRow("hidden", hidden);
};

describe("moveHidden", () => {
  beforeEach(() => before());

  it("keeps a hidden screen that became a tab hidden as that tab", () => {
    before(["/usage", "/sessions", "/worktrees"]);
    moveHidden();
    expect(getSettings().hidden).toEqual(["/usage", "/sessions", "/worktrees", "/code", "/memory"]);
  });

  it("turns the old Sprint report into the Sprint tab", () => {
    before(["/report"]);
    moveHidden();
    expect(getSettings().hidden).toEqual(["/report#sprint", "/code", "/memory"]);
  });

  it("hides all of Reports when nothing of it showed", () => {
    before(["/report", "/weekly", "/usage"]);
    moveHidden();
    expect(getSettings().hidden).toEqual(["/report", "/weekly", "/usage", "/code", "/memory"]);
  });

  it("drops Tasks and doesn't add Code and Memory twice", () => {
    before(["/tasks", "/code", "/memory"]);
    moveHidden();
    expect(getSettings().hidden).toEqual(["/code", "/memory"]);
  });

  it("runs once", () => {
    before(["/report"]);
    moveHidden();
    writeRow("hidden", ["/report"]);
    moveHidden();
    expect(getSettings().hidden).toEqual(["/report"]);
  });

  it("leaves new installs on the default", () => {
    moveHidden();
    expect(readRow("hidden")).toBeUndefined();
    expect(getSettings().hidden).toEqual(["/code", "/memory"]);
  });
});
