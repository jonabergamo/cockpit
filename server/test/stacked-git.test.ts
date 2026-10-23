import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// their PR lives on a branch of a local "origin"; the code host is faked to point at it
vi.mock("../src/providers.ts", async (orig) => ({
  ...(await orig<typeof import("../src/providers.ts")>()),
  parsePr: (s: string) => (/\d+/.test(s) ? { repo: "acme/app", n: Number(s.match(/\d+/)![0]) } : undefined),
  prInfo: async () => ({ title: "Their thing", author: "ana", url: "https://github.com/acme/app/pull/12", state: "OPEN", headRefName: "feat/their-thing", baseRefName: "main" }),
}));

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim();

it("moves a new worktree onto the head of their PR and remembers it", async () => {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "a.txt"), "main\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "main");
  git(origin, "checkout", "-qb", "feat/their-thing");
  writeFileSync(join(origin, "b.txt"), "theirs\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "theirs");
  const theirs = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "main");

  const wt = mkdtempSync(join(tmpdir(), "wt-"));
  execFileSync("git", ["clone", "-q", origin, wt]);
  git(wt, "checkout", "-qb", "feat/mine");

  const { stackOf, stackOnto } = await import("../src/stacked.ts");
  const s = await stackOnto(wt, "12");
  expect(s.sha).toBe(theirs);
  expect(git(wt, "rev-parse", "HEAD")).toBe(theirs);
  expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/mine");
  expect(stackOf(wt)).toMatchObject({ pr: 12, branch: "feat/their-thing", target: "main", base_sha: theirs, state: "open" });
});
