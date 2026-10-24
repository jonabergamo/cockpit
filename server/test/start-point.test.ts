import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { startPoint } from "../src/tasks.ts";

describe("where a task starts", () => {
  it("is the base branch when nothing, or the base branch itself, is given", async () => {
    expect(await startPoint("")).toEqual({});
    expect(await startPoint(config.repo.baseBranch)).toEqual({});
    expect(await startPoint(`origin/${config.repo.baseBranch}`)).toEqual({});
  });
  it("says so when it's neither a PR nor a branch on origin", async () => {
    await expect(startPoint("no such branch!")).rejects.toThrow(/isn't a PR link or number, or a branch on origin/);
  });
});
