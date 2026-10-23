import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Worktree } from "@cockpit/shared";
import { runnerFor, runOptions, scriptKind, scriptsIn, startOption } from "../src/runnable.ts";

const pkg = (dir: string, scripts: Record<string, string>, extra: Record<string, unknown> = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: dir.split("/").pop(), scripts, ...extra }));
};

// a repo with a pnpm workspace, a yarn package inside it, and package.json files that shouldn't count
function repo() {
  const root = mkdtempSync(join(tmpdir(), "cockpit-runnable-"));
  pkg(root, { test: "vitest run", pretest: "echo before", lint: "eslint .", postinstall: "husky", "test:e2e": "playwright test" });
  writeFileSync(join(root, "pnpm-lock.yaml"), "");
  pkg(join(root, "server"), { build: "tsc --noEmit", dev: "tsx watch src/index.ts" });
  pkg(join(root, "apps/legacy"), { check: "tsc -p ." });
  writeFileSync(join(root, "apps/legacy/yarn.lock"), "");
  pkg(join(root, "apps/tool"), { audit: "npm audit" }, { packageManager: "npm@10.0.0" });
  pkg(join(root, "node_modules/dep"), { test: "jest" });
  pkg(join(root, "server/dist"), { start: "node index.js" });
  pkg(join(root, ".cache/x"), { test: "jest" });
  pkg(join(root, "a/b/c/d/e"), { deep: "true" });
  pkg(join(root, "a/b/c/d"), { shallow: "true" });
  return root;
}

describe("package.json scripts", () => {
  const root = repo();
  const scripts = scriptsIn(root);
  const names = scripts.map((s) => `${s.rel}:${s.name}`);

  it("finds every package's scripts, four folders deep at most", () => {
    expect(names).toEqual(expect.arrayContaining([".:test", ".:lint", ".:test:e2e", "server:build", "server:dev", "apps/legacy:check", "apps/tool:audit", "a/b/c/d:shallow"]));
    expect(names).not.toContain("a/b/c/d/e:deep");
  });
  it("leaves out node_modules, build output, dot folders, lifecycle scripts and pre/post hooks", () => {
    expect(names.some((n) => n.startsWith("node_modules") || n.startsWith("server/dist") || n.startsWith(".cache"))).toBe(false);
    expect(names).not.toContain(".:pretest");
    expect(names).not.toContain(".:postinstall");
  });
  it("runs each with the package manager its folder uses", () => {
    const by = (rel: string) => scripts.find((s) => s.rel === rel)!.runner;
    expect(by(".")).toBe("pnpm");
    expect(by("server")).toBe("pnpm");
    expect(by("apps/legacy")).toBe("yarn");
    expect(by("apps/tool")).toBe("npm");
    expect(runnerFor(mkdtempSync(join(tmpdir(), "cockpit-bare-")), "/nowhere")).toBe("npm");
  });
  it("works out the kind from the script's name, then what it runs", () => {
    const kind = (rel: string, name: string) => scriptKind(scripts.find((s) => s.rel === rel && s.name === name)!);
    expect(kind(".", "test")).toBe("unit");
    expect(kind(".", "test:e2e")).toBe("e2e");
    expect(kind(".", "lint")).toBe("lint");
    expect(kind("apps/legacy", "check")).toBe("typecheck");
    expect(kind("apps/tool", "audit")).toBe("audit");
    expect(kind("server", "dev")).toBe("other");
  });
});

describe("run options", () => {
  const root = repo();
  const wt: Worktree = { path: root, name: "ACME-1", branch: "feat/ACME-1/x", ticket: "ACME-1", head: "abc", main: false };
  const deps = { worktrees: async () => [wt] };

  it("lists a known worktree's scripts, grouped by package", async () => {
    const list = await runOptions(root, deps);
    expect(list.worktree).toBe(root);
    const test = list.options.find((o) => o.id === "script:.:test");
    expect(test).toMatchObject({ kind: "unit", label: "test", group: "package.json", source: "cockpit" });
    expect(test!.detail).toContain("pnpm run test");
    expect(list.options.find((o) => o.id === "script:apps/legacy:check")?.group).toBe("apps/legacy/package.json");
    // no repo.verifyCommand in the example config
    expect(list.options.some((o) => o.id === "verify")).toBe(false);
  });
  it("refuses a folder that isn't a known worktree", async () => {
    await expect(runOptions("/etc", deps)).rejects.toMatchObject({ status: 400 });
    await expect(runOptions("", deps)).rejects.toMatchObject({ status: 400 });
    await expect(startOption("/etc", "script:.:test", deps)).rejects.toMatchObject({ status: 400 });
  });
  it("only starts what the worktree's list has", async () => {
    await expect(startOption(root, "script:.:rm -rf", deps)).rejects.toMatchObject({ status: 400, message: "that isn't something this worktree can run" });
    await expect(startOption(root, "", deps)).rejects.toMatchObject({ status: 400 });
    await expect(startOption(root, "plugin:nope:x", deps)).rejects.toMatchObject({ status: 400 });
  });
});
