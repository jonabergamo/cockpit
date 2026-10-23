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
