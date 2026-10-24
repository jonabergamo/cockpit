import { describe, expect, it } from "vitest";
import { burnup, spans, statusAt, workdays, type Transition } from "../src/report.ts";

const h = (key: string, ...steps: [string, string][]): Transition[] => steps.map(([to, at]) => ({ key, to, at }));

describe("sprint maths", () => {
  it("lists workdays only", () => {
    expect(workdays(new Date("2026-10-16T09:00"), new Date("2026-10-20T18:00"))).toEqual(["2026-10-16", "2026-10-19", "2026-10-20"]);
  });

  it("knows the status at a point in time", () => {
    const hist = h("A-1", ["In Progress", "2026-10-15T10:00:00Z"], ["Done", "2026-10-16T15:00:00Z"]);
    expect(statusAt(hist, "2026-10-14T00:00:00Z")).toBeUndefined();
    expect(statusAt(hist, "2026-10-16T12:00:00Z")).toBe("In Progress");
    expect(statusAt(hist, "2026-10-17T00:00:00Z")).toBe("Done");
  });

  it("counts released points per day and leaves the future empty", () => {
    const tickets = [
      { key: "A-1", points: 2 },
      { key: "A-2", points: 3 },
    ];
    const history = new Map([
      ["A-1", h("A-1", ["Done", "2026-10-15T10:00:00Z"])],
      ["A-2", h("A-2", ["In Progress", "2026-10-14T10:00:00Z"])],
    ]);
    const days = ["2026-10-14", "2026-10-15", "2026-10-16"];
    const out = burnup(tickets, history, days, "2026-10-15");
    expect(out.map((p) => p.released)).toEqual([0, 2, NaN]);
    expect(out.map((p) => p.ideal)).toEqual([0, 2.5, 5]);
    expect(out[0].scope).toBe(5);
  });

  it("trusts the tracker's answer for a day and leaves late tickets out", () => {
    const tickets = [
      { key: "A-1", points: 2 },
      { key: "A-2", points: 3 },
      { key: "A-3", points: 1 },
    ];
    // cockpit's own history only saw A-1 finish on the 15th; the tracker knows it was done on the 14th
    const history = new Map([["A-1", h("A-1", ["Done", "2026-10-15T10:00:00Z"])]]);
    const days = ["2026-10-14", "2026-10-15", "2026-10-16"];
    const on = new Map([["2026-10-14", new Set(["A-1"])]]);
    const out = burnup(tickets, history, days, "2026-10-15", new Set(["Done"]), on, new Set(["A-3"]));
    expect(out.map((p) => p.released)).toEqual([2, 2, NaN]);
    expect(out[0].scope).toBe(5);
  });

  it("builds status spans, open ended only while not released", () => {
    const out = spans("A-1", h("A-1", ["Review", "2026-10-15T10:00:00Z"], ["Done", "2026-10-16T10:00:00Z"]), "NOW");
    expect(out).toEqual([
      { key: "A-1", status: "Review", from: "2026-10-15T10:00:00Z", to: "2026-10-16T10:00:00Z" },
      { key: "A-1", status: "Done", from: "2026-10-16T10:00:00Z", to: undefined },
    ]);
  });
});

import { burndown, closedAt, distribution, sayDoOf } from "../src/report.ts";

describe("team style charts", () => {
  it("counts down from the scope and leaves the future empty", () => {
    const out = burndown([
      { date: "a", released: 0, scope: 10, ideal: 0 },
      { date: "b", released: 4, scope: 10, ideal: 5 },
      { date: "c", released: NaN, scope: 10, ideal: 10 },
    ]);
    expect(out).toEqual([
      { date: "a", ideal: 10, remaining: 10 },
      { date: "b", ideal: 5, remaining: 6 },
      { date: "c", ideal: 0, remaining: null },
    ]);
  });

  it("groups points by the configured buckets, then by Jira category", () => {
    const out = distribution([
      { status: "Done", points: 2 },
      { status: "Review", points: 1 },
      { status: "Waiting", statusCategory: "indeterminate", points: 3 },
      { status: "Backlog", statusCategory: "new", points: 5 },
    ]);
    expect(Object.fromEntries(out.map((b) => [b.name, b.points]))).toEqual({ Done: 2, Review: 1, "In Progress": 3, "To Do": 5, Blocked: 0 });
  });

  it("only counts work finished before the sprint ended", () => {
    const tickets = [
      { status: "Done", points: 3, resolvedAt: "2026-10-10T10:00:00.000Z" },
      { status: "Done", points: 2, resolvedAt: "2026-10-20T10:00:00.000Z" },
      { status: "In Progress", points: 5 },
    ];
    expect(sayDoOf(tickets, "2026-10-14T23:00:00.000Z")).toEqual({ committed: 10, completed: 3 });
    expect(sayDoOf(tickets, "2026-10-14T23:00:00.000Z", true)).toEqual({ committed: 10, completed: 5 });
  });

  it("counts until the sprint was closed, not its planned end", () => {
    const sprint = { end: "2026-10-13T23:00:00.000Z", completed: "2026-10-15T12:39:00.000Z" };
    const tickets = [
      { status: "Done", points: 3, resolvedAt: "2026-10-10T10:00:00.000Z" },
      { status: "Done", points: 2, resolvedAt: "2026-10-15T09:00:00.000Z" },
      { status: "Done", points: 1, resolvedAt: "2026-10-16T09:00:00.000Z" },
    ];
    expect(sayDoOf(tickets, closedAt(sprint))).toEqual({ committed: 6, completed: 5 });
    expect(closedAt({ end: sprint.end })).toBe(sprint.end);
  });

  it("counts what was in a done status like QA when the sprint closed, even if it got to Done later", () => {
    const tickets = [
      { key: "A-1", status: "Done", points: 2, resolvedAt: "2026-10-20T10:00:00.000Z" },
      { key: "A-2", status: "Done", points: 3, resolvedAt: "2026-10-21T10:00:00.000Z" },
    ];
    expect(sayDoOf(tickets, "2026-10-15T12:00:00.000Z", false, new Set(["A-1"]))).toEqual({ committed: 5, completed: 2 });
  });
});

import { people } from "../src/report.ts";

describe("people", () => {
  it("sums scope and done per assignee and keeps unassigned apart", () => {
    const rows = people([
      { assignee: "Ana", status: "Done", points: 2 },
      { assignee: "Ana", status: "To Do", points: 3 },
      { status: "Done", points: 1 },
    ]);
    const ana = rows.find((r) => r.name === "Ana")!;
    expect([ana.scope, ana.done, ana.tickets]).toEqual([5, 2, 2]);
    expect(rows.find((r) => r.name === "Unassigned")?.me).toBe(false);
  });
});
