import { beforeEach, describe, expect, it } from "vitest";
import { clearHeld, endFocus, focusState, hold, holding, startFocus, summary } from "../src/focus.ts";
import { putSettings } from "../src/settings.ts";

const finished = (body: string) => ({ title: "Claude finished", body, link: "/terminals", kind: "finished" });

describe("focus mode", () => {
  beforeEach(() => {
    putSettings({ focus: { on: false, since: 0, until: 0 }, alerts: { stuckMinutes: 20, escalateMinutes: 15, holdFinished: true } });
    clearHeld();
  });

  it("holds only a finished turn, and only while focus is on", () => {
    expect(holding(finished("a"))).toBe(false);
    startFocus(25);
    expect(holding(finished("a"))).toBe(true);
    expect(holding({ kind: "notify" })).toBe(false);
    expect(holding({ kind: undefined })).toBe(false);
    expect(holding({ kind: "finished", urgent: true })).toBe(false);
  });

  it("lets everything through when holding is turned off in settings", () => {
    putSettings({ alerts: { stuckMinutes: 20, escalateMinutes: 15, holdFinished: false } });
    startFocus(null);
    expect(holding(finished("a"))).toBe(false);
  });

  it("ends on its own once the time is up, and runs on with no end until turned off", () => {
    const now = Date.now();
    startFocus(25, now);
    expect(focusState(now + 24 * 60_000).on).toBe(true);
    expect(focusState(now + 26 * 60_000).on).toBe(false);
    expect(holding(finished("a"), now + 26 * 60_000)).toBe(false);
    startFocus(null, now);
    expect(focusState(now + 1e9)).toMatchObject({ on: true, until: 0 });
  });

  it("refuses a length it can't use", () => {
    expect(() => startFocus(0)).toThrow();
    expect(() => startFocus(5000)).toThrow();
  });

  it("sums up what this block held when it ends, and keeps the stack for Today", () => {
    const now = Date.now();
    hold(finished("before"), now - 60_000);
    startFocus(50, now);
    hold(finished("Export button"), now + 1000);
    hold(finished("Fix login"), now + 2000);
    hold({ ...finished("Fix login"), node: "linux" }, now + 3000);
    const n = endFocus(now + 4000);
    expect(n).toEqual({ title: "3 sessions finished while you focused", body: "Export button, Fix login", link: "/", kind: "focus" });
    expect(focusState().on).toBe(false);
    expect(focusState().held.map((h) => h.body)).toEqual(["Fix login", "Fix login", "Export button", "before"]);
    expect(focusState().held[0].node).toBe("linux");
    expect(endFocus()).toBeUndefined();
  });

  it("keeps when the block began if it's started again while on", () => {
    const now = Date.now();
    startFocus(25, now);
    startFocus(90, now + 60_000);
    expect(focusState(now + 60_000)).toMatchObject({ since: now, until: now + 60_000 + 90 * 60_000 });
  });

  it("says nothing when nothing waited, and shortens a long list", () => {
    expect(summary([])).toBeUndefined();
    const s = summary(["a", "b", "c", "d"].map((b) => ({ title: "Claude finished", body: b })));
    expect(s?.body).toBe("a, b, c…");
    expect(summary([{ title: "Claude finished", body: "a" }])?.title).toBe("1 session finished while you focused");
  });
});
