import { beforeEach, describe, expect, it } from "vitest";
import type { KitTeam } from "@cockpit/shared";
import { db } from "../src/db.ts";
import { getSettings, putSettings } from "../src/settings.ts";
import { DEFAULT_TEAM, claudeArgs, memberLaunch, teamOf, templateFor } from "../src/templates.ts";
import { READY_KINDS } from "../../web/src/lib/kits.ts";

const bug: KitTeam = {
  worktree: true,
  terms: [
    { id: "investigator", name: "investigator", prompt: "", planFirst: true, cards: ["plan"] },
    { id: "fixer", name: "fixer", prompt: "Fix {ticket}: {summary}", planFirst: false, cards: ["changes", "runs"] },
    { id: "tester", name: "tester", model: "haiku", prompt: "Test the fix for {ticket}", planFirst: false, cards: ["runs"] },
  ],
  lines: [
    { from: "investigator", to: "fixer", role: "plan", both: false, limit: 2 },
    { from: "fixer", to: "tester", role: "custom", prompt: "Run the tests for this and report what fails", both: true, limit: 4 },
  ],
};
const kind = (team?: KitTeam) => ({ id: "bug", name: "Bug", match: "bug", vars: {}, model: "sonnet", prompt: "/fix-ticket {url}", autopilot: "default" as const, ...(team ? { team } : {}) });

beforeEach(() => db.exec("delete from settings"));

describe("kits", () => {
  it("keep a kind's team, and check its lines go between its terminals", () => {
    putSettings({ templates: [kind(bug)] });
    expect(teamOf(templateFor({ summary: "Bug: totals wrong" }))).toEqual(bug);
    expect(() => putSettings({ templates: [kind({ ...bug, lines: [{ from: "investigator", to: "nobody", role: "plan", both: false, limit: 2 }] })] })).toThrow(/isn't in the team/);
    expect(() => putSettings({ templates: [kind({ ...bug, terms: [...bug.terms, bug.terms[0]] })] })).toThrow(/same id/);
    expect(() => putSettings({ templates: [kind({ ...bug, lines: [...bug.lines, { from: "tester", to: "fixer", role: "build", both: false, limit: 4, when: "failing" }] })] })).toThrow(/Two lines between fixer and tester/);
    expect(() => putSettings({ templates: [kind({ ...bug, lines: [{ from: "fixer", to: "tester", role: "custom", both: false, limit: 2 }] })] })).toThrow(/own words/);
    // a kind without one gets the usual pair, the agent planning first
    putSettings({ templates: [kind()] });
    expect(teamOf(getSettings().templates[0])).toEqual(DEFAULT_TEAM);
    expect(DEFAULT_TEAM.terms[0].planFirst).toBe(true);
  });

  it("start each terminal with its own prompt, model and plan mode, the main one with the kind's prompt", () => {
    const tpl = { ...kind(bug), team: bug };
    const t = { key: "ACME-7", url: "https://t/ACME-7", summary: "Totals wrong" };
    const main = memberLaunch(tpl, bug.terms[0], true, t);
    expect(main).toEqual({ command: "claude", args: ["--model", "sonnet", "--permission-mode", "plan", "/fix-ticket https://t/ACME-7"], planned: true });
    expect(memberLaunch(tpl, bug.terms[1], false, t).args).toEqual(["--model", "sonnet", "Fix ACME-7: Totals wrong"]);
    expect(memberLaunch(tpl, bug.terms[2], false, t).args).toEqual(["--model", "haiku", "Test the fix for ACME-7"]);
    // one with no prompt of its own, not the main one: it just opens, and waits for what comes along its lines
    expect(memberLaunch(tpl, { ...bug.terms[1], prompt: "" }, false, t).args).toEqual(["--model", "sonnet"]);
    expect(claudeArgs(undefined, "go", true)).toEqual(["--permission-mode", "plan", "go"]);
  });

  it("ready-made kinds are ones the settings take as they are", () => {
    putSettings({ templates: READY_KINDS.map((k) => ({ ...kind(k.team), id: k.id, name: k.name, match: k.match, prompt: k.prompt })) });
    expect(getSettings().templates.map((t) => t.id)).toEqual(["feature", "bug", "e2e", "discovery"]);
    for (const k of READY_KINDS) expect(teamOf(getSettings().templates.find((t) => t.id === k.id))).toEqual(k.team);
    expect(READY_KINDS.find((k) => k.id === "discovery")?.team.worktree).toBe(false);
  });
});
