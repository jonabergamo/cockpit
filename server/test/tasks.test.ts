import { describe, expect, it } from "vitest";
import type { Task } from "@cockpit/shared";
import { depsMet, pickNext } from "../src/tasks.ts";

let n = 0;
const task = (over: Partial<Task> = {}): Task => ({ id: `t${++n}`, group: "g", title: "t", prompt: "p", attempt: 1, status: "queued", dependsOn: [], createdAt: n, ...over });

describe("task queue", () => {
  it("fills the free slots in order", () => {
    const all = [task({ status: "running" }), task(), task(), task()];
    expect(pickNext(all, 3, 0, 85).map((t) => t.id)).toEqual([all[1].id, all[2].id]);
  });
  it("waits while the 5 hour limit is nearly used", () => {
    expect(pickNext([task()], 3, 90, 85)).toEqual([]);
  });
  it("holds back each agent's tasks by its own limit", () => {
    const claude = task();
    const codex = task({ agent: "codex" });
    const gemini = task({ agent: "gemini" });
    const used = (a: string) => ({ claude: 10, codex: 92 })[a as "claude" | "codex"];
    expect(pickNext([claude, codex, gemini], 3, used, 85).map((t) => t.id)).toEqual([claude.id, gemini.id]);
  });
  it("holds a task until what it depends on is done", () => {
    const first = task({ group: "a", status: "running" });
    const second = task({ group: "b", dependsOn: ["a"] });
    expect(pickNext([first, second], 3, 0, 85)).toEqual([]);
    expect(depsMet(second, [{ ...first, status: "done" }])).toBe(true);
    expect(depsMet(task({ dependsOn: ["missing"] }), [])).toBe(false);
  });
});
