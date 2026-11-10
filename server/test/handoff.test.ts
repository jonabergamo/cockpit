import { describe, expect, it } from "vitest";
import type { Entry } from "@cockpit/shared";
import { db } from "../src/db.ts";
import { dismiss, fallbackNext, lastSaid, parseStatus, pickUp, saveWrap, workDay } from "../src/handoff.ts";

describe("parseStatus", () => {
  it("reads the branch, how far it is from upstream and the files left", () => {
    expect(parseStatus("## feat/ACME-123...origin/feat/ACME-123 [ahead 2, behind 1]\n M src/app.ts\n?? src/new.ts\n")).toEqual({ branch: "feat/ACME-123", dirty: 2, ahead: 2, behind: 1 });
    expect(parseStatus("## main\n")).toEqual({ branch: "main", dirty: 0, ahead: 0, behind: 0 });
    expect(parseStatus("")).toEqual({ branch: undefined, dirty: 0, ahead: 0, behind: 0 });
  });
});

describe("the next step without a model", () => {
  it("is the first sentence it said last and the files left uncommitted", () => {
    expect(fallbackNext({ last: "## Done\n\nThe form saves now. Next is the error state.", dirty: 3 })).toBe("The form saves now. · 3 uncommitted files");
    expect(fallbackNext({ last: undefined, dirty: 1 })).toBe("1 uncommitted file");
    expect(fallbackNext({ dirty: 0 })).toBe("Pick it up where it stopped");
  });

  it("goes by the last thing the agent said", () => {
    const e = (kind: "user" | "assistant", text: string, i: number): Entry => ({ kind, id: `${i}`, ts: new Date(i).toISOString(), text });
    expect(lastSaid([e("assistant", "First.", 1), e("assistant", "Second.", 2), e("user", "ok", 3), e("assistant", "  ", 4)])).toBe("Second.");
  });
});

describe("pick up where you left off", () => {
  const add = (id: string, day: string, at: number) =>
    db.prepare("insert or replace into handoffs (id, day, session_id, title, next, created_at) values (?, ?, ?, ?, ?, ?)").run(id, day, `s-${id}`, `Session ${id}`, "draft", at);

  it("keeps what you saved and edited, shows it from the next day, and hides it once dismissed or old", () => {
    const now = Date.now();
    const today = workDay(now);
    db.prepare("delete from handoffs").run();
    add("a", today, now);
    add("b", today, now);
    expect(saveWrap([{ id: "a", next: "  Write the error state test  " }])).toBe(1);
    // the same day it isn't news yet; the line left out is gone
    expect(pickUp(now)).toEqual([]);
    expect(db.prepare("select count(*) as n from handoffs").get()).toEqual({ n: 1 });

    const tomorrow = now + 24 * 3600_000;
    expect(pickUp(tomorrow).map((h) => [h.id, h.next, h.session])).toEqual([["a", "Write the error state test", "s-a"]]);
    // older than the days kept is hidden
    expect(pickUp(now + 10 * 24 * 3600_000)).toEqual([]);
    dismiss(["a"]);
    expect(pickUp(tomorrow)).toEqual([]);
  });
});
