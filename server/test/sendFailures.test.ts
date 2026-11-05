import { describe, expect, it } from "vitest";
import type { Run } from "@cockpit/shared";
import { shouldSend } from "../src/sendFailures.ts";

const now = Date.now();
const run = (more: Partial<Run> = {}): Run => ({ id: `r-${Math.random()}`, kind: "unit", name: "tests", source: "terminal", status: "fail", startedAt: now - 5000, endedAt: now - 1000, updatedAt: now, summary: {}, artifacts: [], meta: {}, ...more });

describe("sending failed runs to the agent", () => {
  it("sends a fresh failure you or a script started", () => {
    expect(shouldSend(run(), now)).toBe(true);
    expect(shouldSend(run({ source: "wrapper" }), now)).toBe(true);
  });

  it("leaves out what the agent ran itself, CI, passes, quiet and old ones, and fixed or hidden ones", () => {
    expect(shouldSend(run({ source: "hook" }), now)).toBe(false);
    expect(shouldSend(run({ kind: "ci" }), now)).toBe(false);
    expect(shouldSend(run({ status: "pass" }), now)).toBe(false);
    expect(shouldSend(run({ meta: { quiet: true } }), now)).toBe(false);
    expect(shouldSend(run({ endedAt: now - 10 * 60_000 }), now)).toBe(false);
    expect(shouldSend(run({ meta: { fixedBy: "x" } }), now)).toBe(false);
    expect(shouldSend(run({ meta: { dismissed: 1 } }), now)).toBe(false);
  });
});
