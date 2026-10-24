import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Flow, FlowRun } from "@cockpit/shared";
import { describe, expect, it } from "vitest";
import { db } from "../src/db.ts";
import { advance, checkFlow, getFlowRun, holds, retryFlow, tasksOf, verdictOf } from "../src/flows.ts";
import { codex } from "../src/workers/codex.ts";
import { useExtraAgents } from "../src/workers/index.ts";
import { agentRow } from "../src/workers/runner.ts";
import { tailEntries } from "../src/claude/entries.ts";

const script = join(import.meta.dirname, "fixtures/fake-agent.mjs");
useExtraAgents(() => [{ ...codex, id: "fake", name: "Fake", bin: "node", models: () => [], headless: (t) => [script, ...(t.resume ? ["--resume", t.resume] : [])] }]);

describe("reading a flow", () => {
  const flow = (steps: Flow["steps"]): Flow => ({ id: "f", name: "F", steps });
  it("finds what's wrong with one", () => {
    expect(checkFlow(flow([{ id: "a" }, { id: "b", after: ["a"] }]))).toBeUndefined();
    expect(checkFlow(flow([]))).toMatch(/at least one/);
    expect(checkFlow(flow([{ id: "a" }, { id: "a" }]))).toMatch(/same id/);
    expect(checkFlow(flow([{ id: "a", after: ["b"] }, { id: "b" }]))).toMatch(/isn't a step before/);
    expect(checkFlow(flow([{ id: "a" }, { id: "b", loop: { to: "a", max: 2 } }]))).toMatch(/needs output/);
    expect(checkFlow(flow([{ id: "a" }, { id: "b", output: "verdict", loop: { to: "c", max: 2 } }]))).toMatch(/loops back/);
    expect(checkFlow(flow([{ id: "a", when: "nonsense" }]))).toMatch(/condition/);
  });

  it("reads verdicts, conditions and task lists", () => {
    expect(verdictOf("fine\nVERDICT: approve")).toBe("approve");
    expect(verdictOf("VERDICT: approve\n...\n**VERDICT:** changes")).toBe("changes");
    expect(verdictOf("no verdict")).toBe("changes");
    const run = { steps: [{ step: "review", round: 0, status: "done", verdict: "changes" }] } as FlowRun;
    expect(holds(run, "review.verdict == changes")).toBe(true);
    expect(holds(run, "review.verdict != changes && review.status == done")).toBe(false);
    expect(tasksOf('Sure:\n```json\n[{"title":"a","prompt":"do a"},{"title":"b"}]\n```')).toEqual([{ title: "a", prompt: "do a" }]);
    expect(tasksOf("nothing here")).toEqual([]);
  });
});

function insert(flow: Flow) {
  const id = Math.random().toString(36).slice(2, 10);
  const worktree = mkdtempSync(join(tmpdir(), "flow-"));
  db.prepare("insert into flow_runs (id, flow, title, prompt, worktree, status, steps, created_at) values (?, ?, ?, ?, ?, 'running', ?, ?)").run(
    id,
    JSON.stringify(flow),
    "a run",
    "EDIT the thing",
    worktree,
    JSON.stringify(flow.steps.map((s) => ({ step: s.id, round: 0, status: "pending" }))),
    Date.now(),
  );
  return id;
}

async function settle(id: string, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    await advance(id);
    const r = getFlowRun(id)!;
    if (!["running", "starting"].includes(r.status) || Date.now() > end) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
}

describe("running a flow", () => {
  it("passes the work along, loops back on changes and stops after the last round", async () => {
    const id = insert({
      id: "f",
      name: "F",
      steps: [
        { id: "build", agent: "fake", prompt: "{{prompt}}", again: "Fix this: {{steps.review.output}}" },
        { id: "checks", kind: "verify" },
        { id: "review", agent: "fake", access: "readonly", output: "verdict", loop: { to: "build", max: 1 }, prompt: "REVIEW what {{steps.build.output}} did" },
        { id: "ship", agent: "fake", when: "review.verdict == approve" },
      ],
    });
    const r = await settle(id);
    expect(r.status).toBe("done");
    expect(r.steps.map((s) => `${s.step}#${s.round}:${s.status}`)).toEqual(["build#0:done", "checks#0:skipped", "review#0:done", "ship#0:skipped", "build#1:done", "checks#1:skipped", "review#1:done"]);
    expect(r.steps.find((s) => s.step === "review")!.verdict).toBe("changes");
    // the second build went on with the first one's conversation, told what the review said
    const builds = r.steps.filter((s) => s.step === "build");
    expect(builds[1].sessionId).toBe(builds[0].sessionId);
    const said = (await tailEntries(builds[0].sessionId!))!.entries.filter((e) => e.kind === "user").map((e) => (e as { text: string }).text);
    expect(said[1]).toContain("Fix this: Looked at it.\nVERDICT: changes");
    // the reviewer only reads
    expect(agentRow(r.steps.find((s) => s.step === "review")!.sessionId!)!.access).toBe("readonly");
  });

  it("stops at a step that fails, and waits on a person", async () => {
    const failed = await settle(insert({ id: "f", name: "F", steps: [{ id: "a", agent: "fake", prompt: "FAIL" }, { id: "b", agent: "fake" }] }));
    expect(failed.status).toBe("failed");
    expect(failed.steps.map((s) => s.status)).toEqual(["failed", "pending"]);
    // a retry runs the failed step again from scratch, in a new session
    const first = failed.steps[0].sessionId;
    await retryFlow(failed.id);
    const again = await settle(failed.id);
    expect(again.status).toBe("failed");
    expect(again.steps[0].sessionId).not.toBe(first);
    expect(again.steps).toHaveLength(2);
    const waiting = await settle(insert({ id: "f", name: "F", steps: [{ id: "a", agent: "fake" }, { id: "you", kind: "human" }] }));
    expect(waiting.status).toBe("waiting");
    expect(waiting.steps[1].status).toBe("waiting");
  });
});
