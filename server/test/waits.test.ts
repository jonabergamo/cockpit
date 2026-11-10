import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.ts";
import { describeWait, forgetOpen, touchWaits, trackWaits, waitsBetween, waitTotals } from "../src/waits.ts";
import { NODE_TABLES } from "../src/migrate.ts";

const T = 1_700_000_000_000;
const MIN = 60_000;
const s = (id: string, status: "busy" | "idle" | "waiting", updatedAt = T, waitingFor?: string) => ({ id, status, updatedAt, waitingFor });

beforeEach(() => {
  db.exec("delete from session_waits");
  forgetOpen();
});

describe("the waiting ledger", () => {
  it("opens a wait when a session starts waiting and closes it when it stops", () => {
    trackWaits([s("a", "busy")], T);
    trackWaits([s("a", "waiting", T + MIN, "permission")], T + MIN);
    describeWait("a", "wants to run pnpm db:reset");
    expect(waitsBetween(T, T + 60 * MIN)).toEqual([{ session: "a", from: T + MIN, to: undefined, what: "wants to run pnpm db:reset" }]);
    trackWaits([s("a", "busy")], T + 5 * MIN);
    expect(waitsBetween(T, T + 60 * MIN)).toEqual([{ session: "a", from: T + MIN, to: T + 5 * MIN, what: "wants to run pnpm db:reset" }]);
  });

  it("closes the wait of a session that went away, and drops ones too short to matter", () => {
    trackWaits([s("a", "waiting", T), s("b", "waiting", T)], T);
    trackWaits([s("a", "waiting", T), s("b", "idle")], T + 2000);
    trackWaits([], T + 3 * MIN);
    expect(waitsBetween(T - MIN, T + 60 * MIN)).toEqual([{ session: "a", from: T, to: T + 3 * MIN, what: undefined }]);
  });

  it("after a restart, closes a wait that ended meanwhile at when it was last seen, and keeps one still waiting", () => {
    trackWaits([s("a", "waiting", T), s("b", "waiting", T)], T);
    touchWaits(T + 10 * MIN);
    forgetOpen();
    trackWaits([s("b", "waiting", T)], T + 120 * MIN);
    const w = waitsBetween(T - MIN, T + 300 * MIN);
    expect(w).toEqual([
      { session: "a", from: T, to: T + 10 * MIN, what: undefined },
      { session: "b", from: T, to: undefined, what: undefined },
    ]);
  });

  it("adds up the waits inside a window, the open one up to now", () => {
    const waits = [
      { session: "a", from: T - 30 * MIN, to: T + 10 * MIN },
      { session: "b", from: T + 20 * MIN, to: T + 58 * MIN },
      { session: "c", from: T + 100 * MIN },
    ];
    const { ms, longest } = waitTotals(waits, T, T + 200 * MIN, T + 110 * MIN);
    expect(ms).toBe((10 + 38 + 10) * MIN);
    expect(longest).toMatchObject({ session: "b", ms: 38 * MIN });
  });

  it("is kept on the machine the sessions run on", () => {
    expect(NODE_TABLES).toContain("session_waits");
  });
});
