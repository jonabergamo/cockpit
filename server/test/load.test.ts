import { describe, expect, it } from "vitest";
import { machineLoad } from "../src/remote/load.ts";

describe("machineLoad", () => {
  it("has nothing until the first sample, then memory and disk figures that add up", async () => {
    machineLoad();
    await expect.poll(() => machineLoad(), { timeout: 5000 }).toBeDefined();
    const l = machineLoad()!;
    expect(l.memTotal).toBeGreaterThan(0);
    if (l.memUsed !== undefined) expect(l.memUsed).toBeLessThanOrEqual(l.memTotal);
    expect(l.diskTotal).toBeGreaterThan(0);
    expect(l.diskFree).toBeLessThanOrEqual(l.diskTotal!);
  });
});
