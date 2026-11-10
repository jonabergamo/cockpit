import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countsOf } from "../src/runs.ts";
import { testName } from "../src/testOutput.ts";

const output = (name: string) => readFileSync(new URL(`./fixtures/output/${name}.txt`, import.meta.url), "utf8").split("\n");

describe("what a runner's output says failed", () => {
  it("reads vitest, keeping a file that couldn't run", () =>
    expect(countsOf(output("vitest"))).toEqual({ failed: 1, passed: 15, skipped: 2, failing: ["test/broken.test.ts", "test/maths.test.ts > maths > adds things"] }));
  it("reads jest", () => expect(countsOf(output("jest"))).toEqual({ failed: 1, skipped: 1, passed: 9, failing: ["<Menu /> › renders settings from config"] }));
  it("reads pytest, errors included", () =>
    expect(countsOf(output("pytest"))).toEqual({ failed: 2, passed: 11, skipped: 1, failing: ["tests/test_orders.py::TestOrders::test_total", "tests/test_prices.py::test_rounding[half up]"] }));
  it("reads Django's test runner, old and new style", () =>
    expect(countsOf(output("django"))).toEqual({ passed: 7, failed: 2, skipped: 1, failing: ["shop.tests.test_payments.PaymentTests.test_refund", "shop.tests.test_orders.OrderTests.test_total"] }));
  it("reads mocha's numbered failures over their lines", () =>
    expect(countsOf(output("mocha"))).toEqual({ passed: 2, failed: 2, failing: ["Array #indexOf() returns -1 when not present", "Queue drains in order"] }));
  it("reads go test, a subtest instead of its parent and no package", () => expect(countsOf(output("go"))).toEqual({ failing: ["TestTotals/two_items", "TestRound"] }));
  it("reads Playwright, the same test once", () => expect(countsOf(output("playwright"))).toEqual({ failed: 1, skipped: 1, passed: 2, failing: ["tests/basket.spec.ts › Basket › adds an item"] }));
  it("reads a Maestro suite", () => expect(countsOf(output("maestro-suite"))).toEqual({ passed: 2, failed: 1, failing: ["checkout"] }));
  it("reads a single Maestro flow by its name", () => expect(countsOf(output("maestro-flow"))).toEqual({ failing: ["add_to_basket"] }));
  it("reads node --test's TAP, without the suite around a failed test", () => expect(countsOf(output("node-test"))).toEqual({ passed: 1, failed: 1, failing: ["applies the discount"] }));
  it("doesn't take a summary line for a test", () => {
    expect(countsOf(["FAILED (failures=1)", "FAILED: web lint"]).failing).toBeUndefined();
    expect(countsOf(["ERROR something went wrong"]).failing).toBeUndefined();
  });
  it("names a test the same way each time", () => {
    expect(testName("2 [chromium] › tests/a.spec.ts:12:3 › Basket › adds (30.1s)")).toBe("tests/a.spec.ts › Basket › adds");
    expect(testName("adds things 3ms")).toBe("adds things");
    expect(testName("renders (12 ms)")).toBe("renders");
  });
});
