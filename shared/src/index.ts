// waiting: Claude asked you something (a question, a permission prompt, a dialog) and can't go on without you.
// idle: it finished its turn and nothing is pending.
export type SessionStatus = "busy" | "waiting" | "idle" | "ended";

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
  // the cockpit terminal it runs in, when it runs inside one
  term?: string;
  // what a waiting session waits on, as Claude Code puts it: "input needed", "dialog open"...
  waitingFor?: string;
  // shells Claude left running after its turn; the session counts as busy until they end
  background?: number;
  // the machine it ran on, when that's a node rather than this one
  node?: string;
  // the agent it is, when it isn't Claude Code: "codex", "gemini", or "claude" run without a terminal
  agent?: string;
  model?: string;
  // what it used, for agents that count tokens rather than dollars
  tokens?: { input: number; output: number };
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
  // the machine it's on, when that's a node
  node?: string;
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
  // the machine it runs on ("local" for this one), and whether it can be reached: a terminal on a node whose
  // link dropped is still running there, only out of reach until the link comes back
  node?: string;
  state?: TermState;
}

export type TermState = "running" | "disconnected" | "exited";

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
  spend?: TicketSpend;
  // set when the ticket is stacked on an epic that has its own worktree
  epic?: string;
  // the kind of work it matches, by name
  kind?: string;
  priority?: string;
  // released or closed in the tracker, so there's nothing left to work on
  finished?: boolean;
}

export interface Epic extends Ticket {
  children: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  branch: string;
  // the branch it merges into
  base?: string;
  state: string;
  isDraft: boolean;
  reviewDecision?: string;
  checks?: "pass" | "fail" | "pending" | "none";
  // checks failing that the settings say not to count, shown quietly
  ignoredFailing?: string[];
  createdAt: string;
  mergedAt?: string;
  author?: string;
  ticket?: string;
  // MERGEABLE, CONFLICTING or UNKNOWN
  mergeable?: string;
  // the host's own word on it, e.g. CLEAN, BLOCKED, BEHIND, DIRTY
  mergeState?: string;
  headSha?: string;
  // who was asked to review and where each one stands, from the code host and any review source
  reviewers?: Reviewer[];
}

export interface Reviewer {
  name: string;
  // REQUESTED: asked and not answered yet. PENDING is the same from a review source.
  state: "REQUESTED" | "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  // the code host's own login, which can be asked again; a review source's people can't be
  login?: string;
  source?: string;
  // when they last reviewed
  at?: string;
}

export interface ReviewThread {
  path?: string;
  line?: number;
  author?: string;
  body: string;
}

// your last submitted review of a PR and what happened since, for a second look at only what changed
export interface LastReview {
  // the commit you reviewed, and the PR's head now
  commit: string;
  head: string;
  at: string;
  state: string;
  url: string;
  // commits and files since your review; rewritten when the reviewed commit is no longer in the branch (a force-push)
  commits: number;
  files: number;
  rewritten: boolean;
  comments: ReviewThread[];
}

export interface Sprint {
  id: number;
  name: string;
  start?: string;
  end?: string;
  // when it was actually closed, which can be days after end
  completed?: string;
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
  // start over from a clean screen: the whole scrollback follows
  | { type: "pty.reset"; id: string }
  | { type: "pty.exit"; id: string; code: number }
  | { type: "pty.mode"; id: string; tmux: boolean }
  | { type: "terms"; terms: TermInfo[] }
  | { type: "notify"; id: number; title: string; body: string; link: string }
  // the plugin list, screens or themes changed
  | { type: "plugins" }
  // something on the Board changed: tasks, verify results, autopilot
  | { type: "board" }
  | { type: "update"; status: UpdateStatus }
  // a run started, moved on or finished; its output is fetched, not pushed
  | { type: "run"; run: Run }
  // what the sidebar shows next to each screen, by its nav id
  | { type: "badges"; badges: Record<string, Badge> }
  // the machines this hub works with and whether each one can be reached
  | { type: "machines"; machines: Machine[] }
  // a node connected and this hub has its worktrees and folders: what lists them is worth asking again
  | { type: "node.ready"; node: string };

// A node this hub dials. state: up, connecting, down (the link dropped, it's dialing again), or refused (the
// node turned it away: not paired with this hub, or a different link version)
export interface Machine {
  id: string;
  name: string;
  url: string;
  state: "connecting" | "up" | "down" | "refused";
  since: number;
  node?: string;
  rtt?: number;
  error?: string;
  info?: { hostname: string; platform: string; version: string; terminals: number; gpu?: boolean };
}

// A sidebar entry's indicator. live pulses while something runs, attention and failed are what needs you,
// count is a plain total. title spells it out for the tooltip and screen readers.
export interface Badge {
  live?: number;
  attention?: number;
  failed?: number;
  count?: number;
  title: string;
  // a plugin's badge that goes away once its screen is opened
  untilSeen?: boolean;
}

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
export * from "./agents.ts";

// What a running session is showing, for answering it without opening its terminal
export interface Ask {
  screen: string;
  question?: string;
  options: { key: string; label: string }[];
  // text typed into its input box but not sent
  draft?: string;
}
export interface AskInfo extends Partial<Ask> {
  reachable: boolean;
  options: { key: string; label: string }[];
  last?: string;
  pending?: { name: string; input: unknown };
}

export type BoardColumn = "queued" | "working" | "needs" | "review" | "ready" | "quiet";

export interface BoardCard {
  id: string;
  // the machine its work is on, when that's a node
  node?: string;
  kind: "worktree" | "session" | "task";
  title: string;
  ticket?: string;
  folder: string;
  path?: string;
  branch?: string;
  column: BoardColumn;
  // why it's in its column, in a few words
  reason: string;
  session?: { id: string; status: SessionStatus; waitingFor?: string; background?: number; updatedAt: number; name?: string; term?: string; pid?: number; title?: string };
  pr?: { number: number; url: string; title: string; state: string; checks?: PullRequest["checks"]; ignoredFailing?: string[]; review?: string; mergeable?: string; mergeState?: string; isDraft: boolean; reviewers?: Reviewer[] };
  verify?: { state: "running" | "pass" | "fail"; at: number; summary?: string; jobId?: string };
  autopilot?: { on: boolean; attempts: number; gaveUp: boolean; note?: string };
  task?: { id: string; group: string; status: TaskStatus; attempt: number; title: string };
  stuck?: string;
  // the teammate's PR its work is built on, and whether that PR moved on since
  stacked?: { pr: number; url: string; title?: string; author?: string; branch: string; target?: string; state: "open" | "moved" | "merged" | "closed" | "gone"; note?: string };
  // what the ticket's sessions cost so far, against its budget when it has one
  spend?: TicketSpend;
  updatedAt: number;
}

// dollars, or tokens when costs are hidden
export interface TicketSpend {
  spent: number;
  limit?: number;
  unit: "usd" | "tokens";
  warnPct: number;
}

export type TaskStatus = "queued" | "starting" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  group: string;
  title: string;
  prompt: string;
  ticket?: string;
  // the coding agent that does it; Claude Code when unset
  agent?: string;
  model?: string;
  // the kind of work it was queued as
  template?: string;
  // the open PR (link) its worktree starts on, instead of the repo's base branch
  onPr?: string;
  // another branch it starts from, and its PR goes back to
  base?: string;
  // waits for the overnight queue, then runs while you're away
  overnight?: boolean;
  attempt: number;
  status: TaskStatus;
  dependsOn: string[];
  worktree?: string;
  branch?: string;
  jobId?: string;
  termId?: string;
  sessionId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface DigestItem {
  at: number;
  kind: string;
  title: string;
  body?: string;
  link?: string;
}

// --- runs: every test, lint, typecheck, audit, e2e, proof, verify and CI run, wherever it was started ---

export type RunKind = "unit" | "lint" | "typecheck" | "audit" | "e2e" | "proof" | "verify" | "ci" | "other";
export type RunStatus = "running" | "pass" | "fail" | "cancelled";

export interface RunStep {
  text: string;
  state: "running" | "ok" | "failed" | "skipped" | "section";
  // how deep in subflows
  depth: number;
}

export interface RunSummary {
  passed?: number;
  failed?: number;
  skipped?: number;
  // the names of the tests that failed, as the runner printed them
  failing?: string[];
  steps?: RunStep[];
}

// a file kept with the run, in data/runs/<id>/; type is video, image, text or file
export interface RunArtifact {
  name: string;
  path: string;
  type: string;
  // a video cut to these seconds of its original, which is kept so the cut can change or be undone
  trimmed?: { start: number; end: number; at: number };
}

export interface Run {
  id: string;
  // the machine it ran on, when that's a node
  node?: string;
  kind: RunKind;
  name: string;
  // where it came from: hook, wrapper, terminal, verify, ci, mcp, script, or plugin:<id>
  source: string;
  ticket?: string;
  worktree?: string;
  cwd?: string;
  command?: string;
  status: RunStatus;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  // the last time anything was heard from it
  updatedAt: number;
  summary: RunSummary;
  artifacts: RunArtifact[];
  // anything else: the session, the terminal, a phase and progress, a check's url, an error
  meta: { session?: string; terminal?: string; phase?: string; progress?: number; error?: string; url?: string; [key: string]: unknown };
}

// GET /api/runs/:id: the run, the end of its output, its steps, and the plugin panels that show it
export interface RunDetail extends Run {
  tail: string[];
  steps: RunStep[];
  panels: { plugin: string; url: string; steps?: boolean }[];
}

// ---- the ticket pipeline: each of your tickets on the road its kind takes, on the Work screen ----

// A button on a ticket's row: a link when href is set, else the action of the plugin that put it there. The ids
// core runs itself mean the same on a plugin's road: pr, featurepr, ticket, session, board, epic, start (queue a
// task), agent (start the main agent in its worktree), open (ask for the PR) and review (answer the review)
export interface RoadAction {
  id: string;
  label: string;
  primary?: boolean;
  href?: string;
  // the plugin that runs it, when it isn't the row's own
  plugin?: string;
}

// A small tag on a row, like how its tests are doing
export interface RoadBadge {
  label: string;
  tone?: "plain" | "green" | "amber" | "red" | "cobalt";
  href?: string;
  title?: string;
}

// Where a ticket is on its road. steps are the road's stops; at is the one it's on (steps.length when it's at the
// end). open marks stops behind it that aren't actually done ("" open, "bad" failing).
export interface RoadEntry {
  key: string;
  kind: string;
  kindLabel?: string;
  steps: string[];
  at: number;
  open?: Record<number, "" | "bad">;
  bad?: boolean;
  needsYou?: boolean;
  shipping?: boolean;
  // something is working on it right now
  busy?: boolean;
  next: string;
  actions: RoadAction[];
}

// A ticket as the pipeline hands it to plugins: with its worktree, newest PR and queued task already found
export type RoadTicket = Ticket & { worktree?: string; node?: string; pr?: PullRequest; task?: { id: string; status: TaskStatus } };

// What a plugin adds to the pipeline: whole rows for the tickets it knows better (roads), where tickets were
// deployed (where, a stage's name per key, with stages the stops after Merged), tickets that should get a row
// though they aren't yours (extra), tags and buttons on other rows, and notes about what it couldn't read
export interface TicketRoads {
  roads?: RoadEntry[];
  where?: Record<string, string>;
  stages?: string[];
  extra?: Ticket[];
  badges?: Record<string, RoadBadge[]>;
  actions?: Record<string, RoadAction[]>;
  warnings?: string[];
}

export interface PipelineRow extends RoadEntry {
  ticket: Ticket & { offBoard?: boolean };
  pr?: PullRequest;
  featurePr?: PullRequest;
  worktree?: string;
  node?: string;
  // the Board card of its work, to open its drawer
  card?: string;
  session?: { id: string; status: string };
  // the plugin whose road it is, which runs its actions
  plugin?: string;
  badges: RoadBadge[];
}

export interface Pipeline {
  rows: PipelineRow[];
  warnings: { text: string; plugin?: string }[];
}

// ---- cockpit updating itself from its git remote ----

export interface Change {
  sha: string;
  // feat, fix, perf, refactor, docs... from the conventional commit subject; "other" when it doesn't have one
  type: string;
  scope?: string;
  subject: string;
  // the body's first paragraph, which says what it means for you
  detail?: string;
  at: number;
}

export interface UpdateStatus {
  // the commit running now, and the one upstream
  current: string;
  latest?: string;
  branch?: string;
  behind: number;
  changes: Change[];
  // why it can't update itself: uncommitted changes, no upstream, not a git checkout
  blocked?: string;
  // it restarts itself after updating only when a service runs it
  service: boolean;
  // the nodes this hub updates along with itself, and how far behind each is
  nodes?: { machine: string; behind: number; blocked?: string; error?: string }[];
  // updated and about to restart
  restarting?: boolean;
  checkedAt: number;
  error?: string;
}

