import { describe, expect, it } from "vitest";
import { oneLine } from "../src/quick.ts";

describe("oneLine", () => {
  it("keeps the first line of a model's answer, without its quotes and full stop", () => {
    expect(oneLine('"Typecheck and build the web app."\nThis command runs...')).toBe("Typecheck and build the web app");
    expect(oneLine("\n  wants to run pnpm db:reset\n")).toBe("wants to run pnpm db:reset");
    expect(oneLine("**Fix the basket crash**")).toBe("Fix the basket crash");
    expect(oneLine("   ")).toBeUndefined();
    expect(oneLine(undefined)).toBeUndefined();
  });
});
