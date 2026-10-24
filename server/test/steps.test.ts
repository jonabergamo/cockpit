import { describe, expect, it } from "vitest";
import { playwrightSteps } from "../src/steps.ts";

describe("Playwright's output as steps", () => {
  it("lists each test under its file, with how it ended", () => {
    const steps = playwrightSteps([
      "Running 4 tests using 1 worker",
      "  ✓   1 [setup] › tests/auth.setup.ts:21:1 › authenticate (4.7s)",
      "  \x1b[32m✓\x1b[39m   2 [Chrome] › tests/TC01.login.test.ts:22:9 › Module : Login › Login with valid credentials @login @smoke (4.4s)",
      "  ✘   3 [Chrome] › tests/TC01.login.test.ts:35:9 › Module : Login › Wrong password shows the error (1.2m)",
      "  -   4 [Chrome] › tests/TC02.navigation.test.ts:17:9 › Module : Navigation › Home loads",
      "  10 passed (40.1s)",
    ]);
    expect(steps).toEqual([
      { text: "auth.setup.ts", state: "section", depth: 0 },
      { text: "authenticate", state: "ok", depth: 1 },
      { text: "TC01.login.test.ts", state: "section", depth: 0 },
      { text: "Module : Login › Login with valid credentials", state: "ok", depth: 1 },
      { text: "Module : Login › Wrong password shows the error", state: "failed", depth: 1 },
      { text: "TC02.navigation.test.ts", state: "section", depth: 0 },
      { text: "Module : Navigation › Home loads", state: "skipped", depth: 1 },
    ]);
  });
  it("finds nothing in other output", () => {
    expect(playwrightSteps(["$ pnpm test", " ✓ src/a.test.ts (3 tests) 12ms", "Tap on id: x... COMPLETED"])).toEqual([]);
  });
});
