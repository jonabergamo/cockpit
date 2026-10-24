import { describe, expect, it } from "vitest";
import { ack, applyRows, enqueue, lastApplied, since } from "../src/remote/outbox.ts";

const recorder = () => {
  const seen = { notify: [] as string[], log: [] as string[] };
  return { seen, apply: { notify: (n: { title: string }) => void seen.notify.push(n.title), log: (_k: string, title: string) => void seen.log.push(title) } };
};

describe("outbox", () => {
  it("hands each row over once, however often the same page arrives", () => {
    const start = since(0).at(-1)?.seq ?? 0;
    enqueue("notify", { title: "task done", body: "", link: "/" });
    enqueue("log", { kind: "verify", title: "checks passed" });
    const rows = since(start);
    const machine = `test-${Date.now()}`;
    const r = recorder();
    const first = applyRows(machine, rows, r.apply);
    applyRows(machine, rows, r.apply);
    expect(first.due.map((x) => x.data.title)).toEqual(["task done"]);
    expect(r.seen.log).toEqual(["checks passed"]);
    expect(lastApplied(machine)).toBe(rows.at(-1)!.seq);
    ack(lastApplied(machine));
    expect(since(start)).toEqual([]);
  });

  it("logs what happened long ago instead of notifying about it now", () => {
    const start = since(0).at(-1)?.seq ?? 0;
    enqueue("notify", { title: "overnight ended", body: "", link: "/" });
    const r = recorder();
    const got = applyRows(`late-${Date.now()}`, since(start), r.apply, Date.now() + 10 * 60_000);
    expect(got.due).toEqual([]);
    expect(got.stale.map((x) => x.data.title)).toEqual(["overnight ended"]);
    expect(r.seen.log).toEqual(["overnight ended"]);
  });
});
