import { describe, expect, it } from "vitest";
import type { TermInfo } from "@cockpit/shared";
import { badgesOf, clearPluginBadges, computeBadges, markSeen, setPluginBadge, type BadgeInput } from "../src/badges.ts";
import { db } from "../src/db.ts";
import { finishRun, recordRun, startRun } from "../src/runs.ts";

const term = (id: string, more: Partial<TermInfo> = {}): TermInfo => ({ id, title: id, cwd: "/tmp", command: "zsh", createdAt: 0, ...more });
const empty: BadgeInput = { runs: [], runsSeen: 0, terms: [], sessions: [], cards: [], reviews: [], plugins: {} };
const of = (i: Partial<BadgeInput>) => badgesOf({ ...empty, ...i });

describe("badgesOf", () => {
  it("shows nothing when nothing is going on", () => expect(of({})).toEqual({}));

  it("counts runs going and loud failures since you last looked", () => {
    const b = of({
      runsSeen: 100,
      runs: [
        { status: "running", source: "wrapper", meta: {} },
        { status: "running", source: "terminal", meta: {} },
        { status: "fail", source: "wrapper", meta: {}, endedAt: 200 },
        // before you looked, recorded quietly, or from a source that never notifies
        { status: "fail", source: "wrapper", meta: {}, endedAt: 50 },
        { status: "fail", source: "plugin:github", meta: { quiet: true }, endedAt: 200 },
        { status: "fail", source: "hook", meta: {}, endedAt: 200 },
      ],
    });
    expect(b["/runs"]).toEqual({ live: 2, failed: 1, title: "2 runs going · 1 failed since you last looked" });
  });

  it("counts terminal tabs and the Claude sessions in them, not split shells or closed ones", () => {
    const b = of({
      terms: [term("a", { session: "s1" }), term("b", { pid: 42 }), term("c", { parent: "a" }), term("d", { exited: 1 }), term("e")],
      sessions: [
        { id: "s1", status: "busy" },
        { id: "s2", pid: 42, status: "waiting" },
        { id: "s3", status: "busy" },
      ],
    });
    expect(b["/terminals"]).toEqual({ count: 3, live: 1, attention: 1, title: "3 terminals open · Claude working in 1 · 1 waiting for you" });
    expect(b["/sessions"]).toEqual({ live: 2, attention: 1, title: "2 sessions working · 1 waiting for you" });
  });

  it("takes Work's needs and working columns", () => {
    const b = of({ cards: [{ column: "needs" }, { column: "working" }, { column: "working" }, { column: "review" }] });
    expect(b["/board"]).toEqual({ attention: 1, live: 2, title: "1 needs you · 2 working" });
  });

  it("leaves PRs you already reviewed out of the review queue, like the Reviews screen", () => {
    const b = of({
      queue: [{ url: "u1" }, { url: "u2" }, { url: "u3" }],
      reviews: [
        { url: "u1", status: "done" },
        { url: "u2", status: "running" },
        { url: "u9", status: "waiting" },
      ],
    });
    expect(b["/reviews"]).toEqual({ attention: 2, live: 1, title: "1 PR waiting for your review · 1 review being written · 1 review waiting for you" });
  });

  it("has no review count while the queue hasn't been fetched", () => expect(of({ reviews: [{ url: "u1", status: "done" }] })["/reviews"]).toBeUndefined());

  it("passes plugin badges through by their nav id", () => {
    const b = of({ plugins: { "plugin:e2e/tests": { live: 1, title: "1 flow running" } } });
    expect(b["plugin:e2e/tests"]).toEqual({ live: 1, title: "1 flow running" });
  });
});

describe("computeBadges", () => {
  it("starts counting failures from the first look, and again from each visit to Runs", async () => {
    // other test files write runs to the same database, so this one lives a while in the future
    db.prepare("delete from settings where key = 'badges-seen'").run();
    const t0 = Date.now() + 1e9;
    const before = recordRun({ name: "before", status: "fail", exitCode: 1, endedAt: t0 - 10 }, "wrapper");
    expect((await computeBadges(t0))["/runs"]?.failed).toBeUndefined();

    const after = recordRun({ name: "after", status: "fail", exitCode: 1, startedAt: t0, endedAt: t0 + 10 }, "wrapper");
    const quiet = recordRun({ name: "quiet", status: "fail", exitCode: 1, startedAt: t0, endedAt: t0 + 10, quiet: true }, "plugin:x");
    const going = startRun({ name: "going" }, "wrapper");
    const b = (await computeBadges(t0 + 20))["/runs"];
    expect(b?.failed).toBe(1);
    expect(b?.live).toBeGreaterThanOrEqual(1);

    markSeen("/runs", t0 + 20);
    expect((await computeBadges(t0 + 30))["/runs"]?.failed).toBeUndefined();
    finishRun(going.id, { exitCode: 0 });
    db.prepare("delete from runs where id in (?, ?, ?, ?)").run(before.id, after.id, quiet.id, going.id);
  });

  it("keeps a plugin's badge until it's cleared, and drops an untilSeen one once its screen is opened", async () => {
    setPluginBadge("demo", "main", { failed: 2, live: -1, title: "2 broken" });
    setPluginBadge("demo", "other", { attention: 1, title: "look", untilSeen: true });
    let b = await computeBadges();
    expect(b["plugin:demo/main"]).toEqual({ failed: 2, title: "2 broken" });
    expect(b["plugin:demo/other"]).toMatchObject({ attention: 1, untilSeen: true });
    markSeen("plugin:demo/other");
    b = await computeBadges();
    expect(b["plugin:demo/other"]).toBeUndefined();
    clearPluginBadges("demo");
    expect((await computeBadges())["plugin:demo/main"]).toBeUndefined();
  });
});
