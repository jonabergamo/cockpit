import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { branchChanges, branchFileDiff } from "../src/files.ts";

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "cockpit-branch-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "app.ts"), "one\ntwo\n");
  writeFileSync(join(repo, "old.ts"), "gone soon\n");
  git("add", ".");
  git("commit", "-qm", "start");
  git("checkout", "-qb", "feat/thing");
  writeFileSync(join(repo, "app.ts"), "one\ntwo\nthree\n");
  git("rm", "-q", "old.ts");
  git("commit", "-qam", "add three");
  // not committed yet: a changed file and a new one git doesn't track
  writeFileSync(join(repo, "app.ts"), "one\n2\nthree\n");
  writeFileSync(join(repo, "new.ts"), "fresh\nfile\n");
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("branchChanges", () => {
  it("shows the branch against where it split off, what isn't committed included", async () => {
    const b = await branchChanges(repo);
    expect(b).toMatchObject({ branch: "feat/thing", base: "main", ahead: 1, behind: 0, more: 0 });
    expect(b.commits.map((c) => c.subject)).toEqual(["add three"]);
    const by = Object.fromEntries(b.files.map((f) => [f.path, f]));
    expect(by["app.ts"]).toMatchObject({ status: "M", added: 2, removed: 1, committed: false });
    expect(by["old.ts"]).toMatchObject({ status: "D", added: 0, removed: 1, committed: true });
    expect(by["new.ts"]).toMatchObject({ status: "U", committed: false });
  });

  it("gives one file's diff against the base, a new file as all added", async () => {
    expect(await branchFileDiff(repo, "app.ts")).toMatch(/-two\n\+2\n\+three/);
    expect(await branchFileDiff(repo, "new.ts")).toBe("--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+fresh\n+file");
    await expect(branchFileDiff(repo, "../outside")).rejects.toThrow();
  });

  it("only shows what isn't committed on the base branch itself", async () => {
    git("stash", "-qu");
    git("checkout", "-q", "main");
    writeFileSync(join(repo, "app.ts"), "changed on main\n");
    const b = await branchChanges(repo);
    expect(b).toMatchObject({ branch: "main", ahead: 0, commits: [] });
    expect(b.files.map((f) => f.path)).toEqual(["app.ts"]);
  });
});
