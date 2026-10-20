export type SessionStatus = "busy" | "idle" | "ended";

export interface Session {
  id: string;
  project: string;
  cwd: string;
  title?: string;
  name?: string;
  status: SessionStatus;
  pid?: number;
  startedAt: number;
  updatedAt: number;
  branch?: string;
  ticket?: string;
  worktree?: string;
  costUSD?: number;
  linesAdded?: number;
  linesRemoved?: number;
  lastPrompt?: string;
  size: number;
}

export type Entry =
  | { kind: "user"; id: string; ts: string; text: string }
  | { kind: "assistant"; id: string; ts: string; text: string; model?: string }
  | { kind: "thinking"; id: string; ts: string; text: string }
  | { kind: "tool"; id: string; ts: string; toolUseId: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; ts: string; toolUseId: string; text: string; isError: boolean }
  | { kind: "system"; id: string; ts: string; subtype: string; text: string }
  | { kind: "cost"; id: string; ts: string; costUSD: number; linesAdded: number; linesRemoved: number; models: Record<string, ModelUsage> };

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface Subagent {
  id: string;
  type: string;
  description: string;
  toolUseId?: string;
  model?: string;
  finished: boolean;
  workflowRun?: string;
  phase?: string;
}

export interface WorkflowAgent {
  key?: string;
  label: string;
  agentId?: string;
  phase?: string;
  state: string;
  model?: string;
  lastToolName?: string;
  lastToolSummary?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  resultPreview?: string;
}

export interface WorkflowRun {
  runId: string;
  sessionId: string;
  project: string;
  name: string;
  status: string;
  startTime?: number;
  durationMs?: number;
  summary?: string;
  phases: { title: string; detail?: string }[];
  agents: WorkflowAgent[];
  agentCount?: number;
  totalTokens?: number;
  scriptPath?: string;
  live: boolean;
}

export interface Worktree {
  path: string;
  name: string;
  branch?: string;
  head: string;
  ticket?: string;
  main: boolean;
  dirty?: number;
  ahead?: number;
  behind?: number;
  lastCommitAt?: number;
  lastCommitSubject?: string;
  sizeBytes?: number;
}

export interface TermInfo {
  id: string;
  title: string;
  cwd: string;
  command: string;
  createdAt: number;
  exited?: number;
  pid?: number;
  session?: string;
  // a split shell that belongs to this terminal, kept out of the tab bar
  parent?: string;
}

export interface Ticket {
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  type?: string;
  points?: number;
  assignee?: string;
  inSprint: boolean;
  url?: string;
  lastSession?: { id: string; status: string; updatedAt: number } | null;
  // set when the ticket is stacked on an epic that has its own worktree
  epic?: string;
  priority?: string;
}

export interface Epic extends Ticket {
  children: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  branch: string;
  state: string;
  isDraft: boolean;
  reviewDecision?: string;
  checks?: "pass" | "fail" | "pending" | "none";
  createdAt: string;
  mergedAt?: string;
  author?: string;
  ticket?: string;
}

export interface Sprint {
  id: number;
  name: string;
  start?: string;
  end?: string;
  goal?: string;
}

export interface FileNode {
  path: string;
  status?: string;
}

export interface ConfigFile {
  path: string;
  label: string;
  group: "global" | "memory" | "skill" | "plan" | "settings" | "project" | "workflow";
  project?: string;
  mtime: number;
  size: number;
}

export interface Memory {
  file: string;
  name: string;
  description: string;
  type: string;
  indexed: boolean;
}

export interface DoctorIssue {
  level: "warn" | "error";
  where: string;
  message: string;
}

export interface BurnPoint {
  date: string;
  released: number;
  scope: number;
  ideal: number;
}

export interface StatusSpan {
  key: string;
  status: string;
  from: string;
  to?: string;
}

export interface DayActivity {
  date: string;
  transitions: { key: string; from?: string; to: string; at: string }[];
  prsOpened: PullRequest[];
  prsMerged: PullRequest[];
  sessions: { id: string; title?: string; ticket?: string; costUSD?: number }[];
  commits: { sha: string; subject: string; at: string; ticket?: string }[];
  costUSD: number;
}

export type ServerEvent =
  | { type: "sessions"; sessions: Session[] }
  | { type: "session.update"; session: Session }
  | { type: "entries"; sessionId: string; agentId?: string; entries: Entry[] }
  | { type: "workflow"; run: WorkflowRun }
  | { type: "job"; id: string; chunk?: string; done?: boolean; code?: number }
  | { type: "pty.data"; id: string; data: string }
  | { type: "pty.exit"; id: string; code: number }
  | { type: "pty.mode"; id: string; tmux: boolean }
  | { type: "terms"; terms: TermInfo[] }
  | { type: "notify"; id: number; title: string; body: string; link: string }
  // the plugin list, screens or themes changed
  | { type: "plugins" };

export type ClientEvent =
  | { type: "watch"; sessionId: string; agentId?: string; offset: number }
  | { type: "unwatch"; sessionId: string; agentId?: string }
  | { type: "pty.attach"; id: string }
  | { type: "pty.input"; id: string; data: string }
  | { type: "pty.resize"; id: string; cols: number; rows: number }
  | { type: "pty.scroll"; id: string; lines: number }
  | { type: "pty.search"; id: string; query: string; step: "find" | "next" | "prev" | "close" };

export const ticketUrl = (base: string, key: string) => `${base.replace(/\/$/, "")}/browse/${key}`;
export * from "./themes.ts";
export * from "./plugin.ts";
