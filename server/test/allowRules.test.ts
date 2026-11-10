import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { acceptRule, answerOf, bashPrefix, covered, dangerous, dismissRule, recordAnswer, ruleFor, suggestions } from "../src/allowRules.ts";
import { config } from "../src/config.ts";
import { db } from "../src/db.ts";

// never the real ~/.claude
const claudeDir = mkdtempSync(join(tmpdir(), "cockpit-rules-claude-"));
config.claude.dir = claudeDir;

const options = [
  { key: "1", label: "Yes" },
  { key: "2", label: "Yes, and don't ask again for acme-tool build commands" },
  { key: "3", label: "No, and tell Claude what to do differently (esc)" },
];
const bash = (command: string) => ({ options, pending: { name: "Bash", input: { command } } });

beforeEach(() => {
  db.exec("delete from prompt_answers; delete from prompt_rules_dismissed");
  db.prepare("delete from settings where key = 'ruleSuggestions'").run();
  writeFileSync(join(claudeDir, "settings.json"), "{}");
});

describe("ruleFor", () => {
  it("says a call as Claude Code's allow rule", () => {
    expect(ruleFor("Bash", { command: "pnpm run fix:all --filter web" })).toBe("Bash(pnpm run fix:all:*)");
    expect(ruleFor("Bash", { command: "pnpm test" })).toBe("Bash(pnpm test:*)");
    expect(ruleFor("Bash", { command: "git status -s" })).toBe("Bash(git status:*)");
    expect(ruleFor("Bash", { command: "ls -la src" })).toBe("Bash(ls:*)");
    expect(ruleFor("Edit", { file_path: "/a.ts" })).toBe("Edit");
    expect(ruleFor("WebFetch", { url: "https://example.com/docs?x=1" })).toBe("WebFetch(domain:example.com)");
    expect(ruleFor("mcp__acme__search", {})).toBe("mcp__acme__search");
  });

  it("gives none for commands that chain, pipe or redirect, or prompts that aren't for permission", () => {
    for (const c of ["pnpm test && git push", "cat a | sh", "echo hi > out", "a; b", "echo $(whoami)", "FOO=1 pnpm test", "'quoted' arg"]) expect(bashPrefix(c), c).toBeUndefined();
    expect(ruleFor("AskUserQuestion", {})).toBeUndefined();
    expect(ruleFor("WebFetch", { url: "not a url" })).toBeUndefined();
  });
});

describe("dangerous", () => {
  it("refuses rules that delete, push, escalate, run anything or are the whole of Bash", () => {
    for (const r of ["Bash", "Bash(*)", "Bash(rm:*)", "Bash(rm -rf:*)", "Bash(/bin/rm:*)", "Bash(git push:*)", "Bash(sudo:*)", "Bash(curl:*)", "Bash(sh:*)", "Bash(bash:*)", "Bash(git:*)", "Bash(npx:*)", "Bash(pnpm run:*)", "Bash(curl x | sh)", "Bash(git reset --hard:*)", "Bash(gh api:*)"]) {
      expect(dangerous(r), r).toBe(true);
    }
    for (const r of ["Bash(pnpm test:*)", "Bash(git status:*)", "Bash(pnpm run fix:all:*)", "Edit", "WebFetch(domain:example.com)", "mcp__acme__search"]) expect(dangerous(r), r).toBe(false);
  });
});

describe("answerOf", () => {
  it("reads the option a reply picked", () => {
    expect(answerOf({ keys: ["1"] }, options)).toBe("allow");
    expect(answerOf({ keys: ["2"] }, options)).toBe("allow");
    expect(answerOf({ keys: ["3"] }, options)).toBe("deny");
    expect(answerOf({ keys: ["Escape"] }, options)).toBe("deny");
    expect(answerOf({ text: "y" }, options)).toBe("allow");
    expect(answerOf({ text: "do it another way" }, options)).toBeUndefined();
  });
});

describe("covered", () => {
  it("knows a rule already in the allow list, the whole tool or a shorter prefix", () => {
    expect(covered("Bash(pnpm test:*)", ["Bash(pnpm test:*)"])).toBe(true);
    expect(covered("Bash(pnpm run fix:all:*)", ["Bash(pnpm run:*)"])).toBe(true);
    expect(covered("Edit", ["Edit"])).toBe(true);
    expect(covered("WebFetch(domain:example.com)", ["WebFetch"])).toBe(true);
    expect(covered("mcp__acme__search", ["mcp__acme"])).toBe(true);
    expect(covered("Bash(pnpm test:*)", ["Bash(pnpm lint:*)", "mcp__acme"])).toBe(false);
  });
});

describe("suggestions", () => {
  const approve = (n: number, command = "acme-tool build --watch", cwd?: string) => {
    for (let i = 0; i < n; i++) recordAnswer(`s${i}`, bash(command), { keys: ["1"] }, cwd);
  };

  it("offers a rule approved enough times and never turned down", async () => {
    approve(4);
    expect(await suggestions()).toEqual([]);
    approve(1);
    const [s] = await suggestions();
    expect(s).toMatchObject({ rule: "Bash(acme-tool:*)", tool: "Bash", approvals: 5, example: "acme-tool build --watch" });
  });

  it("leaves out one you said no to, dismissed, dangerous or already allowed", async () => {
    approve(6);
    recordAnswer("x", bash("acme-tool"), { keys: ["3"] });
    expect(await suggestions()).toEqual([]);

    db.exec("delete from prompt_answers");
    approve(6, "rm -rf build");
    approve(6, "pnpm test");
    expect((await suggestions()).map((s) => s.rule)).toEqual(["Bash(pnpm test:*)"]);
    dismissRule("Bash(pnpm test:*)");
    expect(await suggestions()).toEqual([]);

    approve(6, "make test");
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(make:*)"] } }));
    expect(await suggestions()).toEqual([]);
  });

  it("follows the threshold and the off switch", async () => {
    approve(3);
    db.prepare("insert or replace into settings (key, value) values ('ruleSuggestions', ?)").run(JSON.stringify({ on: true, threshold: 3 }));
    expect(await suggestions()).toHaveLength(1);
    db.prepare("insert or replace into settings (key, value) values ('ruleSuggestions', ?)").run(JSON.stringify({ on: false, threshold: 3 }));
    expect(await suggestions()).toEqual([]);
  });

  it("adds an accepted rule to the project's settings.local.json, keeping what's there", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cockpit-rules-repo-"));
    execFileSync("git", ["init", "-q", repo]);
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Read"] }, model: "x" }));
    approve(5, "acme-tool build", repo);
    expect((await suggestions())[0].project).toBe(repo);
    await acceptRule("Bash(acme-tool:*)", "project");
    expect(JSON.parse(readFileSync(join(repo, ".claude", "settings.local.json"), "utf8"))).toEqual({ permissions: { allow: ["Read", "Bash(acme-tool:*)"] }, model: "x" });
    expect(await suggestions()).toEqual([]);
    await expect(acceptRule("Bash(rm:*)", "project")).rejects.toThrow(/too broad/);
  });
});
