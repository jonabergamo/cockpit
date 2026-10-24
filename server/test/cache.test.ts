import { describe, expect, it } from "vitest";
import { cached } from "../src/db.ts";

describe("cached", () => {
  it("shares one fetch between concurrent misses", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    };
    const [a, b] = await Promise.all([cached("t:share", 1000, fn), cached("t:share", 1000, fn)]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    expect(await cached("t:share", 1000, fn)).toBe(1);
  });

  it("force refetches one key and leaves the others alone", async () => {
    await cached("t:force:a", 60_000, async () => "a1");
    await cached("t:force:b", 60_000, async () => "b1");
    expect(await cached("t:force:a", 60_000, async () => "a2", true)).toBe("a2");
    expect(await cached("t:force:a", 60_000, async () => "a3")).toBe("a2");
    expect(await cached("t:force:b", 60_000, async () => "b2")).toBe("b1");
  });
});

describe("cached, with nothing to keep", () => {
  it("returns undefined without failing, and asks again next time", async () => {
    let calls = 0;
    const fn = async () => (calls++, undefined);
    expect(await cached("t:nothing", 60_000, fn)).toBeUndefined();
    expect(await cached("t:nothing", 60_000, fn)).toBeUndefined();
    expect(calls).toBe(2);
  });
});
