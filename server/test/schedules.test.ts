import { beforeEach, describe, expect, it } from "vitest";
import type { TermInfo } from "@cockpit/shared";

const { db } = await import("../src/db.ts");
const canvas = await import("../src/canvas.ts");
const { addSchedule, due, listSchedules, nextRun, runSchedule, updateSchedule } = await import("../src/schedules.ts");

// a Wednesday, 9:00 local time
const wed9 = new Date(2026, 10, 4, 9, 0, 0);
const at = (h: number, m = 0, day = wed9) => {
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
};

beforeEach(() => db.exec("delete from schedules; delete from canvas_nodes; delete from canvas_edges; delete from canvases;"));

describe("schedules", () => {
  it("are due once their time has come on one of their days, and only until they've run", () => {
    const s = { at: "08:30", days: [1, 2, 3, 4, 5], on: true };
    expect(due({ ...s, lastRun: undefined }, wed9)).toBe(true);
    expect(due({ ...s, lastRun: at(8, 31).getTime() }, wed9)).toBe(false);
    // ran yesterday: due again today
    expect(due({ ...s, lastRun: at(8, 31, new Date(2026, 10, 3)).getTime() }, wed9)).toBe(true);
    // before its time, on a day it isn't for, or off
    expect(due({ ...s, at: "09:30" }, wed9)).toBe(false);
    expect(due({ ...s, days: [0, 6] }, wed9)).toBe(false);
    expect(due({ ...s, on: false }, wed9)).toBe(false);
  });

  it("say when they run next", () => {
    expect(nextRun({ at: "09:30", days: [3], on: true }, wed9)).toBe(at(9, 30).getTime());
    // today's time is past: the next of its days
    expect(nextRun({ at: "08:30", days: [1, 2, 3, 4, 5], on: true }, wed9)).toBe(at(8, 30, new Date(2026, 10, 5)).getTime());
    expect(nextRun({ at: "08:30", days: [3], on: true }, wed9)).toBe(at(8, 30, new Date(2026, 10, 11)).getTime());
    expect(nextRun({ at: "08:30", days: [3], on: false }, wed9)).toBeUndefined();
  });

  it("check what they're given, and a new one doesn't run at once", () => {
    const ok = { name: "Morning e2e", cwd: "/repo", prompt: "Run the e2e suite", at: "00:00", days: [0, 1, 2, 3, 4, 5, 6] };
    expect(() => addSchedule({ ...ok, at: "25:00" })).toThrow(/HH:MM/);
    expect(() => addSchedule({ ...ok, days: [] })).toThrow(/day/);
    expect(() => addSchedule({ ...ok, prompt: " " })).toThrow(/what the agent/);
    const s = addSchedule(ok);
    // its time today has passed, but it was made after it
    expect(due(s)).toBe(false);
    expect(updateSchedule(s.id, { on: false })?.on).toBe(false);
    expect(listSchedules()).toHaveLength(1);
  });

  it("start their agent in their folder, with their prompt, on their machine, and put its card on their workspace", async () => {
    const ws = canvas.createCanvas("Mornings");
    const s = addSchedule({ name: "Sum up PRs", cwd: "/repo", node: "devbox", prompt: "Sum up the open PRs", at: "08:00", days: [1], canvas: ws.id });
    const spawned: { machine?: string; opts: { cwd: string; title?: string; args?: string[] } }[] = [];
    const term = (id: string): TermInfo => ({ id, title: "t", cwd: "/repo", command: "claude", createdAt: 0, node: "devbox" });
    await runSchedule(s.id, {
      local: (opts) => (spawned.push({ opts }), term("local-t")),
      remote: async (machine, opts) => (spawned.push({ machine, opts }), term("remote-t")),
    } as never);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ machine: "devbox", opts: { cwd: "/repo", title: "⏰ Sum up PRs" } });
    expect(spawned[0].opts.args).toContain("Sum up the open PRs");
    expect(listSchedules()[0]).toMatchObject({ lastTerm: "remote-t" });
    await new Promise((r) => setTimeout(r, 1200));
    expect(canvas.listCanvases().find((c) => c.id === ws.id)?.nodes.some((n) => n.kind === "term" && n.ref === "remote-t")).toBe(true);
  });

  it("say why the last run didn't start", async () => {
    const s = addSchedule({ name: "x", cwd: "/repo", node: "gone", prompt: "p", at: "08:00", days: [1] });
    await expect(runSchedule(s.id, { local: () => ({}) as never, remote: async () => Promise.reject(new Error("gone isn't connected right now")) } as never)).rejects.toThrow();
    expect(listSchedules()[0].lastError).toBe("gone isn't connected right now");
  });
});
