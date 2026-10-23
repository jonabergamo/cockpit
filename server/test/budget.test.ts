import { describe, expect, it } from "vitest";
import { levelOf } from "../src/budget.ts";

describe("levelOf", () => {
  it("stays quiet under the warning", () => expect(levelOf(7.99, 10, 80)).toBe(0));
  it("warns from the warning percentage", () => expect(levelOf(8, 10, 80)).toBe(80));
  it("is over at the budget", () => expect(levelOf(10, 10, 80)).toBe(100));
  it("a warning at 100% only fires when it's over", () => expect(levelOf(9.5, 10, 100)).toBe(0));
});
