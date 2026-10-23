import { describe, expect, it } from "vitest";
import { checks, ignoring } from "../../plugins/github/server.ts";

describe("ignored checks", () => {
  it("matches names and * patterns, ignoring case", () => {
    const skip = ignoring(["dependency-check", "security-audit-*"]);
    expect(skip("dependency-check")).toBe(true);
    expect(skip("Dependency-Check")).toBe(true);
    expect(skip("security-audit-web-app")).toBe(true);
    expect(skip("dependency-check-extra")).toBe(false);
    expect(skip("tests")).toBe(false);
  });

  it("takes text as well as a list", () => {
    const skip = ignoring("dependency-check, lint\nsecurity-*");
    expect(["dependency-check", "lint", "security-audit"].every(skip)).toBe(true);
    expect(ignoring(undefined)("anything")).toBe(false);
    expect(ignoring("")("anything")).toBe(false);
  });

  it("leaves a PR passing when only an ignored check fails", () => {
    const rollup = [
      { name: "tests", conclusion: "SUCCESS" },
      { name: "dependency-check", conclusion: "FAILURE" },
    ];
    const skip = ignoring(["dependency-check"]);
    expect(checks(rollup)).toBe("fail");
    expect(checks(rollup.filter((r) => !skip(r.name)))).toBe("pass");
  });
});
