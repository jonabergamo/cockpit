import { describe, expect, it } from "vitest";
import { searchTerms } from "../src/ask.ts";
import { toMatch } from "../src/claude/search.ts";

describe("ask cockpit", () => {
  it("keeps the words worth searching for", () => expect(searchTerms("When did I fix the basket total?")).toEqual(["fix", "basket", "total"]));
  it("matches any word for a question", () => expect(toMatch("basket total", true)).toBe('"basket" OR "total"*'));
  it("still needs every word in plain search", () => expect(toMatch("basket total")).toBe('"basket" "total"*'));
});
