import type { AgentAccess } from "./agents.ts";

// Flows: a recipe of steps that hand one piece of work from agent to agent in a single worktree. Plan with one,
// build with another, check, review with a third, and go back when the review asks for changes.

// agent: a coding agent's turn. verify: the repo's verifyCommand. human: waits for you to continue or send back.
// tasks: an agent's turn that answers with a list of tasks, each queued as a task of its own; the step ends when
// they all have.
export type FlowStepKind = "agent" | "verify" | "human" | "tasks";

export interface FlowStep {
  id: string;
  name?: string;
  kind?: FlowStepKind;
  agent?: string;
  model?: string;
  // what the agent is told, with {{prompt}}, {{title}}, {{ticket}}, {{base}}, {{diff}}, {{steps.<id>.output}} and
  // {{steps.<id>.verdict}}. Empty is the run's own prompt.
  prompt?: string;
  // what it's told when the step runs again after a loop sent the work back; its conversation goes on from before
  again?: string;
  access?: AgentAccess;
  // the steps it waits for; the one before it when unset, none when []
  after?: string[];
  // runs only when this holds, like `review.verdict == changes`; skipped otherwise
  when?: string;
  // verdict: the agent ends with VERDICT: approve or VERDICT: changes, which `when` and `loop` read
  output?: "text" | "verdict";
  // when this step's verdict is changes, run again from step `to`, at most max times
  loop?: { to: string; max: number };
}

export interface Flow {
  id: string;
  name: string;
  description?: string;
  steps: FlowStep[];
}

export type FlowRunStatus = "starting" | "running" | "waiting" | "done" | "failed" | "cancelled";
export type FlowStepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";

export interface FlowRunStep {
  step: string;
  // how many times a loop has sent the work back to it, from 0
  round: number;
  status: FlowStepStatus;
  sessionId?: string;
  jobId?: string;
  // the task groups a tasks step queued
  tasks?: string[];
  output?: string;
  verdict?: "approve" | "changes";
  startedAt?: number;
  finishedAt?: number;
}

export interface FlowRun {
  id: string;
  flow: Flow;
  title: string;
  prompt: string;
  ticket?: string;
  worktree?: string;
  branch?: string;
  // where its branch starts instead of the base branch: an open PR to build on, or another branch
  onPr?: string;
  base?: string;
  status: FlowRunStatus;
  steps: FlowRunStep[];
  createdAt: number;
  finishedAt?: number;
  error?: string;
}
