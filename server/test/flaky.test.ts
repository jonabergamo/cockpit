import { describe, expect, it } from "vitest";
import { failingOn, flakyStep } from "../src/autopilot.ts";
import { flakiness, flakyChecks, flakyOf, forgetFlaky, type FlakyInput } from "../src/flaky.ts";
import { recordRun } from "../src/runs.ts";

const rules = { minRuns: 6, minFailPct: 15, maxFailPct: 85, days: 30 };
let t = 1_000;
const run = (status: string, sha?: string, more: Partial<FlakyInput> = {}): FlakyInput => ({ kind: "ci", name: "build", status, startedAt: (t += 1000), sha, ...more });

describe("flakiness", () => {
  it("counts a check that passed and failed on the same commit, with when it last flipped", () => {
    const runs = [run("fail", "a"), run("pass", "a"), run("pass", "b")];
    const [c] = flakiness(runs, rules);
    expect(c).toMatchObject({ kind: "ci", name: "build", runs: 3, fails: 1, passes: 2, flips: 1, lastFlip: runs[1].startedAt, why: "passed and failed on the same commit once" });
  });
  it("counts one that fails about half of its runs once it has run enough", () => {
    const half = ["fail", "pass", "fail", "pass", "pass", "fail"].map((s, i) => run(s, `c${i}`));
    expect(flakiness(half, rules)[0]).toMatchObject({ flips: 0, why: "fails 50% of its 6 runs" });
    expect(flakiness(half.slice(0, 5), rules)).toEqual([]);
  });
  it("leaves out what always fails or rarely does", () => {
    expect(flakiness(Array.from({ length: 8 }, (_, i) => run("fail", `d${i}`)), rules)).toEqual([]);
    expect(flakiness(Array.from({ length: 10 }, (_, i) => run(i === 0 ? "fail" : "pass", `e${i}`)), rules)).toEqual([]);
  });
  it("leaves out proofs and cancelled runs, and keeps checks apart by kind and name", () => {
    expect(flakiness([run("fail", "a", { kind: "proof" }), run("pass", "a", { kind: "proof" })], rules)).toEqual([]);
    expect(flakiness([run("fail", "a"), run("cancelled", "a")], rules)).toEqual([]);
    expect(flakiness([run("fail", "a"), run("pass", "a", { name: "lint" }), run("pass", "a", { kind: "unit" })], rules)).toEqual([]);
  });
  it("puts the tests that failed on a commit it also passed on first", () => {
    const runs = [run("fail", "a", { failing: ["slow one"] }), run("fail", "b", { failing: ["broken one"] }), run("fail", "b", { failing: ["broken one"] }), run("pass", "a")];
    expect(flakiness(runs, rules)[0].tests).toEqual([
      { name: "slow one", fails: 1, flips: 1 },
      { name: "broken one", fails: 2, flips: 0 },
    ]);
  });
});

describe("flaky checks from the runs table", () => {
  it("counts CI checks and clean local runs, not runs on a tree with changes", () => {
    const name = `check-${Math.random()}`;
    const sha = `sha-${Math.random()}`;
    recordRun({ kind: "ci", name, status: "fail", quiet: true, meta: { sha } }, "plugin:test");
    recordRun({ kind: "ci", name, status: "pass", quiet: true, meta: { sha } }, "plugin:test");
    const local = `local-${Math.random()}`;
    recordRun({ kind: "unit", name: local, status: "fail", quiet: true, meta: { sha, dirty: true } }, "script");
    recordRun({ kind: "unit", name: local, status: "pass", quiet: true, meta: { sha, dirty: true } }, "script");
    forgetFlaky();
    expect(flakyOf("ci", name)).toMatchObject({ flips: 1, fails: 1, passes: 1 });
    expect(flakyChecks().some((c) => c.name === local)).toBe(false);
  });
});

describe("autopilot and flaky checks", () => {
  const flaky = (n: string) => n.startsWith("flaky");
  it("re-runs a commit's checks once when every failing one is flaky", () => {
    expect(flakyStep(["flaky e2e"], flaky, undefined, "a")).toBe("rerun");
    expect(flakyStep(["flaky e2e", "lint"], flaky, undefined, "a")).toBe("send");
    expect(flakyStep([], flaky, undefined, "a")).toBe("send");
    expect(flakyStep(["flaky e2e"], flaky, { sha: "old", at: 0 }, "a")).toBe("rerun");
  });
  it("waits a few minutes for the re-run, then hands it over", () => {
    expect(flakyStep(["flaky e2e"], flaky, { sha: "a", at: 1000 }, "a", 1000 + 60_000)).toBe("wait");
    expect(flakyStep(["flaky e2e"], flaky, { sha: "a", at: 1000 }, "a", 1000 + 10 * 60_000)).toBe("send");
  });
  it("reads which checks fail on a commit now from the last run of each", () => {
    const sha = `sha-${Math.random()}`;
    recordRun({ kind: "ci", name: "e2e", status: "fail", quiet: true, startedAt: 1, meta: { sha } }, "plugin:test");
    recordRun({ kind: "ci", name: "e2e", status: "pass", quiet: true, startedAt: 2, meta: { sha } }, "plugin:test");
    recordRun({ kind: "ci", name: "lint", status: "fail", quiet: true, startedAt: 3, meta: { sha } }, "plugin:test");
    recordRun({ kind: "ci", name: "audit", status: "fail", quiet: true, startedAt: 4, meta: { sha, ignored: true } }, "plugin:test");
    expect(failingOn(sha)).toEqual(["lint"]);
  });
});
