import { describe, expect, it } from "vitest";
import { fill, parseConcat, slugify, ticketOf } from "../src/util.ts";

describe("util", () => {
  it("parses back to back json documents", () => {
    expect(parseConcat('{"a":1}\n{"b":"}{"}\n[1,2]')).toEqual([{ a: 1 }, { b: "}{" }, [1, 2]]);
  });

  it("finds ticket keys", () => {
    expect(ticketOf(undefined, "feat/ACME-412/saved-cards")).toBe("ACME-412");
    expect(ticketOf("main")).toBeUndefined();
  });

  it("only quotes template values that need it", () => {
    expect(fill('ssh mac "code {path}"', { path: "/home/me/wt/ACME-1/app" })).toBe('ssh mac "code /home/me/wt/ACME-1/app"');
    expect(fill("claude -p {prompt}", { prompt: "it's done" })).toBe(`claude -p 'it'\\''s done'`);
    expect(fill("{unknown}", {})).toBe("{unknown}");
  });

  it("slugifies summaries", () => {
    expect(slugify("[FE] Saved cards on checkout & order grid")).toBe("fe-saved-cards-on-checkout-order-grid");
    expect(slugify("Tradução em sueco")).toBe("traducao-em-sueco");
  });
});
