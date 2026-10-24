import { describe, expect, it } from "vitest";
import { inHours } from "../src/overnight.ts";

describe("inHours", () => {
  it("runs past midnight", () => {
    expect(inHours(23, 23, 8)).toBe(true);
    expect(inHours(3, 23, 8)).toBe(true);
    expect(inHours(8, 23, 8)).toBe(false);
    expect(inHours(15, 23, 8)).toBe(false);
  });

  it("works inside one day too", () => {
    expect(inHours(2, 1, 6)).toBe(true);
    expect(inHours(6, 1, 6)).toBe(false);
  });

  it("is off with no start hour, or the same start and end", () => {
    expect(inHours(3, -1, 8)).toBe(false);
    expect(inHours(3, 3, 3)).toBe(false);
  });
});

describe("the night and its settings", () => {
  it("keep apart: starting a night keeps the cap, saving settings keeps the night", async () => {
    const { endNight, moveNight, night, startNight } = await import("../src/overnight.ts");
    const { getSettings, putSettings, writeRow } = await import("../src/settings.ts");
    endNight("test", false);
    putSettings({ overnight: { ...getSettings().overnight, capMTokens: 33 } });
    startNight("you");
    expect(getSettings().overnight.capMTokens).toBe(33);
    putSettings({ overnight: { ...getSettings().overnight, capMTokens: 34 } });
    expect(night().on).toBe(true);
    endNight("test", false);
    // a night left in the settings' row by an older cockpit moves to its own
    writeRow("overnight-night", null);
    writeRow("overnight", { on: true, since: 1, by: "you", capMTokens: 35 });
    moveNight();
    expect(night()).toMatchObject({ on: true, since: 1, by: "you" });
    expect(getSettings().overnight.capMTokens).toBe(35);
    endNight("test", false);
  });
});
