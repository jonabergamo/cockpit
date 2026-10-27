import { describe, expect, it } from "vitest";
import type { BoardCard, PullRequest, Ticket } from "@cockpit/shared";
import { buildPipeline, featureChain, type PipelineInput } from "../src/pipeline.ts";

const ticket = (key: string, more: Partial<Ticket> = {}): Ticket => ({ key, summary: `Do ${key}`, status: "In Progress", inSprint: true, url: `https://t/${key}`, ...more });
const pr = (n: number, more: Partial<PullRequest> = {}): PullRequest => ({ number: n, title: `PR ${n}`, url: `https://pr/${n}`, branch: `b${n}`, base: "main", state: "OPEN", isDraft: false, createdAt: "2026-10-01", ...more });
const card = (more: Partial<BoardCard>): BoardCard => ({ id: "c", kind: "worktree", title: "", folder: "", column: "quiet", reason: "Nothing running", updatedAt: 0, ...more });
const input = (more: Partial<PipelineInput>): PipelineInput => ({ tickets: [], prs: { mine: [] }, worktrees: [], cards: [], plugins: [], agent: "Codex", noCode: "on[- ]?call|holiday", mainBranches: ["main", "staging"], ...more });
const row = (i: Partial<PipelineInput>, key = "A-1") => buildPipeline(input(i)).rows.find((r) => r.key === key)!;

describe("ticket pipeline", () => {
  it("walks a code ticket along its road", () => {
    expect(row({ tickets: [ticket("A-1")] })).toMatchObject({ kind: "code", at: 0, needsYou: true, next: "Not started", actions: [{ id: "start" }] });
    const wt = [{ path: "/w/a1", ticket: "A-1", main: false }];
    expect(row({ tickets: [ticket("A-1")], worktrees: wt })).toMatchObject({ at: 1, next: "Worktree ready, no Codex yet", actions: [{ id: "agent", label: "Start Codex" }] });
    const started = ticket("A-1", { lastSession: { id: "s1", status: "idle", updatedAt: 1 } });
    expect(row({ tickets: [started], worktrees: wt, cards: [card({ path: "/w/a1", column: "quiet", reason: "Codex finished its turn" })] })).toMatchObject({ at: 2, actions: [{ id: "open" }] });
    const waiting = row({ tickets: [started], worktrees: wt, prs: { mine: [pr(5, { ticket: "A-1" })] }, cards: [card({ path: "/w/a1", column: "review", reason: "Waiting on Ana" })] });
    expect(waiting).toMatchObject({ at: 3, next: "Waiting on Ana", pr: { number: 5 }, needsYou: false });
    expect(waiting.steps).toEqual(["Worktree", "Codex", "PR", "Review", "Merged", "Done"]);
    const merged = pr(5, { ticket: "A-1", state: "MERGED" });
    expect(row({ tickets: [started], worktrees: wt, prs: { mine: [merged] } })).toMatchObject({ at: 5, shipping: true });
    expect(row({ tickets: [{ ...started, status: "Done", statusCategory: "done" }], worktrees: wt, prs: { mine: [merged] } })).toMatchObject({ at: 6, next: "Done", shipping: true });
  });

  it("asks you to answer a review and to talk to a waiting agent", () => {
    const t = ticket("A-1", { lastSession: { id: "s1", status: "waiting", updatedAt: 1 } });
    const wt = [{ path: "/w/a1", ticket: "A-1", main: false }];
    const changes = row({ tickets: [t], worktrees: wt, prs: { mine: [pr(5, { ticket: "A-1" })] }, cards: [card({ path: "/w/a1", column: "needs", reason: "Ana asked for changes" })] });
    expect(changes).toMatchObject({ bad: true, needsYou: true, actions: [{ id: "review" }] });
    const ask = row({ tickets: [t], worktrees: wt, cards: [card({ path: "/w/a1", column: "needs", reason: "Codex is waiting for you", session: { id: "s1", status: "waiting", updatedAt: 1 } })] });
    expect(ask.actions).toEqual([{ id: "session", label: "Answer Codex", primary: true }]);
  });

  it("goes on through the stages a plugin knows", () => {
    const t = ticket("A-1", { lastSession: { id: "s1", status: "ended", updatedAt: 1 } });
    const prs = { mine: [pr(5, { ticket: "A-1", state: "MERGED" })] };
    const plugins = (where: string) => [{ plugin: "deploys", name: "Deploys", roads: { stages: ["Staging", "Production"], where: { "A-1": where } } }];
    const staged = row({ tickets: [t], prs, plugins: plugins("staging") });
    expect(staged.steps.slice(-2)).toEqual(["Staging", "Production"]);
    expect(staged).toMatchObject({ at: 6, next: "Staging, on its way to production" });
    expect(row({ tickets: [t], prs, plugins: plugins("production") })).toMatchObject({ at: 7, next: "In production" });
  });

  it("follows a stacked feature chain to the PR that ships it", () => {
    const step = pr(5, { ticket: "A-1", base: "feat/a", state: "MERGED" });
    const mid = pr(6, { branch: "feat/a", base: "feat/top", state: "MERGED" });
    const top = pr(7, { branch: "feat/top", base: "main", reviewers: [{ name: "Ana", state: "REQUESTED" }] });
    expect(featureChain(step, [step, mid, top], ["main"])).toEqual({ featurePr: top, branch: "feat/top" });
    const r = row({ tickets: [ticket("A-1")], prs: { mine: [step, mid], review: [top] } });
    expect(r).toMatchObject({ kind: "feature", at: 5, featurePr: { number: 7 } });
    expect(r.next).toBe("In feat/a; the feature PR waits on Ana (stacked: waiting on feat/top)");
    // nobody has a PR for the branch the chain ends in
    expect(featureChain(step, [step, mid], ["main"])).toEqual({ featurePr: undefined, branch: "feat/top" });
  });

  it("puts tickets with no code aside, and says a closed PR needs you", () => {
    expect(row({ tickets: [ticket("A-1", { summary: "On-call this week" })] })).toMatchObject({ kind: "nocode", steps: [] });
    expect(row({ tickets: [ticket("A-1")], prs: { mine: [pr(5, { ticket: "A-1", state: "CLOSED" })] } })).toMatchObject({ needsYou: true, next: "PR closed without merging" });
  });

  it("lets a plugin's road take a row over, and says when a plugin failed", () => {
    const plugins = [
      { plugin: "e2e", name: "Tests", roads: { roads: [{ key: "A-1", kind: "e2e", kindLabel: "E2E", steps: ["Flows pass", "PR"], at: 0, next: "Write the tests", actions: [{ id: "e2e-start", label: "Write the tests" }] }], badges: { "A-2": [{ label: "flows failing", tone: "red" as const }] }, extra: [ticket("X-9")] } },
      { plugin: "broken", name: "Broken", roads: {}, error: "boom" },
    ];
    const p = buildPipeline(input({ tickets: [ticket("A-1"), ticket("A-2")], plugins }));
    expect(p.rows.find((r) => r.key === "A-1")).toMatchObject({ kind: "e2e", plugin: "e2e", next: "Write the tests" });
    expect(p.rows.find((r) => r.key === "A-2")).toMatchObject({ kind: "code", badges: [{ label: "flows failing" }] });
    expect(p.rows.find((r) => r.key === "X-9")?.ticket.offBoard).toBe(true);
    expect(p.warnings).toEqual([{ text: "Broken didn't answer (boom), so what it adds to tickets isn't shown.", plugin: "broken" }]);
  });
});
