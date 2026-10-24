import type { Badge, LastReview, PullRequest, Reviewer, ReviewThread, Run, RunArtifact, RunKind, RunStatus, RunStep, RunSummary, Session, Sprint, Task, TermInfo, Ticket } from "./index.ts";
import type { Theme } from "./themes.ts";

// The contract between cockpit and its plugins. See plugins/PLUGINS.md for the guide.
export const PLUGIN_API = 1;

export type SettingValue = string | number | boolean | string[] | { [key: string]: unknown };

export interface SettingSpec {
  key: string;
  label: string;
  // list is several lines of text, json is any JSON value
  type: "text" | "secret" | "bool" | "choice" | "number" | "list" | "json";
  default?: SettingValue;
  choices?: string[];
  help?: string;
  // passed to the plugin's commands as this environment variable, e.g. GH_TOKEN
  env?: string;
}

export interface Requirement {
  id: string;
  name: string;
  // a command whose success means the tool is there; its first output line is shown as the version
  check: string[];
  // succeeds when logged in
  auth?: string[];
  // interactive, run in a terminal
  login?: string[];
  // runs as a job when it needs no sudo; otherwise shown to copy
  install?: { linux?: string; darwin?: string };
  docs?: string;
  optional?: boolean;
  // settings of this plugin that can stand in for a CLI login, e.g. a token
  settings?: string[];
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  api: number;
  description?: string;
  author?: string;
  homepage?: string;
  // a bundled plugin that starts off until turned on; yours always start off
  defaultOn?: boolean;
  // also runs on the hub's nodes, set up the same, for work the hub puts there
  nodes?: boolean;
  settings?: SettingSpec[];
  requires?: Requirement[];
  // Claude Code skills the plugin relies on. One with a folder in the plugin's skills/ ships with it and Setup
  // can install it; one without is only checked for, e.g. a skill of your own.
  skills?: { name: string; required?: boolean }[];
  // screens the plugin no longer has, by id, and the cockpit path that took each one's place, so old links
  // and notifications still land somewhere
  moved?: Record<string, string>;
}

export interface ScreenInfo {
  plugin: string;
  id: string;
  title: string;
  // URL of the page, served from the plugin's folder
  url: string;
  // a page of settings: on the Settings page, not in the sidebar
  settings?: boolean;
}

export type PluginState = "on" | "off" | "error" | "loading";

// What GET /api/plugins returns for each plugin; secrets come back masked
export interface PluginInfo {
  manifest: Manifest;
  bundled: boolean;
  dir: string;
  on: boolean;
  state: PluginState;
  error?: string;
  hasCode: boolean;
  // installed from a git link: where from and which commit; the folder in the repo when it isn't the root
  source?: { url: string; ref?: string; path?: string; commit: string; installedAt: number };
  settings: Record<string, SettingValue>;
  screens: ScreenInfo[];
  // the node it runs on, when this hub has put it on one
  machine?: string;
  themes: string[];
  provides: ("tracker" | "codeHost" | "reviewSource" | "access")[];
}

export type PluginEvent =
  | "session.started"
  | "session.idle"
  | "session.waiting"
  | "session.ended"
  | "session.stuck"
  | "worktree.created"
  | "worktree.removed"
  | "terminal.opened"
  // { id, code, run? }: a terminal's command ended
  | "terminal.exited"
  | "notify"
  | "task.started"
  | "task.done"
  | "autopilot.acted"
  | "verify.done"
  // a Run, when it starts and when it ends
  | "run.started"
  | "run.done";

export interface RouteRequest {
  query: Record<string, string>;
  body: unknown;
  params: Record<string, string>;
  // lower-case names
  headers: Record<string, string>;
}

// --- providers: what a tracker or code host plugin hands cockpit ------------------------

// How the tracker's statuses map to the sprint report: which count as released, done, and the chart groups
export interface StatusConfig {
  statusOrder: string[];
  releasedStatuses: string[];
  // done for the sprint (QA, UAT) even if not released; empty means the released ones
  doneStatuses: string[];
  buckets: Record<string, string[]>;
}

// parent is the epic or story a ticket belongs to, with its title, status and type when the tracker gives them
export type TrackerTicket = Ticket & { created?: string; parent?: string; parentSummary?: string; parentStatus?: string; parentType?: string; statusChangedAt?: string; resolvedAt?: string };
export type TrackerSprint = Sprint & { state: string };

// A work tracker, like Jira or Linear. Only myTickets and statusesOf are required; the rest light up more of
// cockpit (the sprint report needs sprints and sprintTickets, epics need worktreeEpics and epicInfo).
export interface Tracker {
  name: string;
  // how a ticket key looks in branch names and titles, e.g. "[A-Z][A-Z0-9]+-\\d+"
  keyPattern?: string;
  statusConfig(): StatusConfig;
  // whether a ticket is assigned to the person using cockpit
  isMine(t: { assignee?: string }): boolean;
  me?(): string | undefined;
  myTickets(force?: boolean): Promise<Ticket[]>;
  statusesOf(keys: string[], force?: boolean): Promise<Ticket[]>;
  search?(query: string, force?: boolean): Promise<Ticket[]>;
  // story points by ticket key, for trackers whose searches leave them out; null is a ticket with none, and a key
  // missing from the answer is one whose points couldn't be read
  pointsOf?(keys: string[], force?: boolean): Promise<Record<string, number | null>>;
  assignToMe?(key: string): Promise<void>;
  sprints?(): Promise<TrackerSprint[]>;
  activeSprint?(): Promise<TrackerSprint | undefined>;
  // every ticket in a sprint, the active one when no id, with points
  sprintTickets?(sprintId?: number, force?: boolean, maxAge?: number): Promise<TrackerTicket[]>;
  // the keys of a sprint's tickets that were in one of these statuses at the end of a day (YYYY-MM-DD, in the
  // tracker's own time zone), from its history; it keeps the burndown right about days cockpit wasn't watching
  inStatusOn?(sprintId: number, statuses: string[], day: string): Promise<string[]>;
  worktreeEpics?(keys: string[], force?: boolean): Promise<(Ticket & { children: string[] })[]>;
  epicInfo?(key: string): Promise<{ key: string; summary: string; isEpic: boolean }>;
}

export interface PrRef {
  repo: string;
  n: number;
}

// A code host, like GitHub or GitLab. myPrs is required; reviews need parsePr, prInfo and pendingReview.
export interface CodeHost {
  name: string;
  myPrs(fresh?: boolean): Promise<PullRequest[]>;
  reviewQueue?(fresh?: boolean): Promise<PullRequest[]>;
  deploys?(since: string): Promise<unknown[]>;
  // the failing checks of a PR with the end of their logs, for the "fix the checks" prompt
  failingChecks?(n: number): Promise<{ name: string; state: string; link: string; tail: string }[]>;
  // unresolved review threads on one of your PRs, for handing them to Claude
  reviewThreads?(n: number): Promise<ReviewThread[]>;
  parsePr?(input: string): PrRef | undefined;
  prInfo?(ref: PrRef): Promise<{ title: string; author: string; url: string; additions?: number; deletions?: number; changedFiles?: number; state?: string; isDraft?: boolean; headRefName?: string; headRefOid?: string; baseRefName?: string }>;
  pendingReview?(ref: PrRef): Promise<{ id: number; url: string; comments: number } | undefined>;
  deletePending?(ref: PrRef, id: number): Promise<unknown>;
  // your last submitted review of the PR, what changed since and the comments you left, for "review what changed"
  lastReview?(ref: PrRef): Promise<LastReview | undefined>;
  // asks these people (code host logins) for a review, again when they already reviewed
  requestReview?(n: number, logins: string[]): Promise<unknown>;
}

// More PRs waiting for your review, from somewhere that is not the code host: a rota, a review board, a queue
// of your own. They join the code host's own queue on the PR reviews screen, deduplicated by url.
export interface ReviewSource {
  name: string;
  queue(fresh?: boolean): Promise<PullRequest[]>;
  // who it put on your own PRs, by PR url, so the Board can say who a PR is waiting on
  reviewersOf?(fresh?: boolean): Promise<{ url: string; reviewers: Reviewer[] }[]>;
}

// Lets requests from other machines in. Cockpit alone only answers its own machine; anything proxied or remote
// gets in when an access plugin says yes, like Tailscale's login header, a VPN or a reverse proxy's auth.
export interface AccessRequest {
  header(name: string): string | undefined;
  // the address the request came from, and whether that's this machine (a proxy in front of cockpit is)
  remote?: string;
  local: boolean;
}
export interface AccessProvider {
  name: string;
  // true lets it in; anything else leaves it to the other access plugins. Keep it quick, it runs on every request.
  allow(req: AccessRequest): boolean | undefined;
}

// --- runs: what a plugin hands cockpit to record a run ----------------------------------

export interface RunStart {
  name?: string;
  // worked out from the command with the patterns in Settings when left out
  kind?: RunKind;
  ticket?: string;
  worktree?: string;
  // the branch it ran on, to find its worktree and ticket when there's no cwd
  branch?: string;
  cwd?: string;
  command?: string;
  startedAt?: number;
  meta?: Record<string, unknown>;
}

// The events a script reporting a run sends: output lines, raw step lines, progress from 0 to 1, a phase, an error, and
// the result. Phase "done" (or "failed", "cancelled") ends the run.
export interface RunEvent {
  phase?: string;
  lines?: string[];
  steps?: string[];
  progress?: number;
  error?: string;
  result?: { status?: number; file?: string; [key: string]: unknown };
  summary?: RunSummary;
  // files to keep with the run, by absolute path; they're copied into its folder
  artifacts?: { path: string; name?: string; type?: string }[];
  meta?: Record<string, unknown>;
}

export interface RunFilter {
  ticket?: string;
  worktree?: string;
  kind?: RunKind;
  status?: RunStatus;
  since?: number;
  limit?: number;
}

// The worktree (or the main checkout) someone picked in "Run something"
export interface RunTarget {
  path: string;
  name?: string;
  branch?: string;
  ticket?: string;
  main?: boolean;
}

// One thing "Run something" offers for a worktree. id only has to be unique among the plugin's own options;
// group puts it under a heading (a package's folder, the plugin's name when left out)
export interface RunOption {
  id: string;
  kind: RunKind;
  label: string;
  detail?: string;
  group?: string;
}

// What starting an option gave: the run to open, else the terminal, else a note to show (with a page to follow it on)
export interface RunOptionStarted {
  runId?: string;
  term?: string;
  note?: string;
  link?: string;
}

// GET /api/runs/options: everything that can run in a worktree, with where each came from ("cockpit" or a plugin's
// name) and the plugins whose list failed. A plugin's ids come back as plugin:<plugin id>:<its id>
export interface RunOptionList {
  worktree: string;
  options: (RunOption & { source: string; group: string })[];
  errors: { source: string; error: string }[];
}

// The object a plugin's setup(k) gets. Everything it registers is dropped when the plugin turns off or reloads.
export interface Cockpit {
  readonly id: string;
  readonly dataDir: string;
  readonly assetsDir: string;
  setting<T = string>(key: string): T;
  log(...args: unknown[]): void;
  store: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void };
  // served at /api/plugins/<id>/x<path>; return JSON-able data, or a Response for anything else (audio, files),
  // and throw an Error with .status 400 for bad input
  route(method: "GET" | "POST" | "PUT" | "DELETE", path: string, handler: (req: RouteRequest) => unknown): void;
  // page is a file in the plugin folder, e.g. "assets/index.html"
  // settings: a page of settings rather than a screen, listed on the Settings page instead of in the sidebar
  screen(s: { id: string; title: string; page: string; settings?: boolean }): void;
  theme(t: Theme): void;
  on(event: PluginEvent, fn: (data: unknown) => void): void;
  // runs a command with the plugin's env settings set (tokens and the like)
  run(cmd: string, args: string[], opts?: { cwd?: string; input?: string }): Promise<string>;
  // session ties the terminal to a Claude session it resumes; run records what it runs as a run, with its output
  // and exit code, and the run's id comes back as runId. It opens as a split beside the Claude terminal of the same
  // folder when there is one; beside: false makes it a tab of its own
  terminal(t: { cwd: string; title?: string; command?: string; args?: string[]; session?: string; beside?: boolean; run?: { kind?: RunKind; name?: string; ticket?: string } }): TermInfo & { runId?: string };
  // closes one of cockpit's terminals, ending what runs in it
  closeTerminal(id: string): void;
  // Claude sessions cockpit knows, newest first
  sessions(opts?: { liveOnly?: boolean; limit?: number }): Session[];
  terminals(): TermInfo[];
  claude(c: { cwd: string; prompt?: string; title?: string }): TermInfo;
  notify(n: { title: string; body?: string; link?: string; urgent?: boolean }): void;
  // types a message into a running Claude session cockpit hosts, and presses Enter; false when it can't reach it
  sendToSession(sessionId: string, text: string): Promise<boolean>;
  // queues work for a new worker: a worktree and branch, then Claude with the prompt
  task(t: { title: string; prompt?: string; ticket?: string; attempts?: number; model?: string; dependsOn?: string[] }): Promise<Task[]>;
  // a shell command whose output streams to cockpit's job log
  job(label: string, command: string, cwd?: string): Promise<{ code: number; output: string }>;
  onStop(fn: () => void): void;
  // Other machines (Settings → Machines). where says which one a kind of work is put on: a machine's id, or
  // undefined for this one. A function exposed with expose can be called by this same plugin from another
  // machine with remote(machine).call: files are paths on the calling machine, copied over (only what's new
  // since the last call when a file just grew) and handed to the function as paths on its own machine.
  where(cap: "headless" | "whisper"): string | undefined;
  expose(name: string, fn: (args: any, files: Record<string, string>) => unknown): void;
  remote(machine: string): { call<T = unknown>(name: string, args?: unknown, opts?: { files?: Record<string, string>; timeoutMs?: number }): Promise<T> };
  // remembered in cockpit's cache table for maxAge ms; force fetches again. Keys are kept per plugin.
  cache<T>(key: string, maxAge: number, fn: () => Promise<T>, force?: boolean): Promise<T>;
  // finds a ticket key in branch names, titles and the like, with the active tracker's pattern
  ticketOf(...hay: (string | undefined)[]): string | undefined;
  // the branch that is production, set once on the Sprint report; empty when nobody has set it
  productionBranch(): string;
  tracker(t: Tracker): void;
  codeHost(h: CodeHost): void;
  // adds to the PR reviews queue without replacing the code host
  reviewSource(s: ReviewSource): void;
  access(a: AccessProvider): void;
  // runs on the Runs screen: record one as it goes (start, then events) or in one go once it's over
  runs: {
    start(r: RunStart): Run;
    event(id: string, e: RunEvent): Run | undefined;
    // quiet: a failure doesn't notify, for runs copied in or caught up on after the fact
    record(r: RunStart & { status: RunStatus; exitCode?: number; endedAt?: number; output?: string; summary?: RunSummary; artifacts?: RunArtifact[]; quiet?: boolean }): Run;
    list(f?: RunFilter): Run[];
    get(id: string): Run | undefined;
    // turns the raw step lines of these kinds of runs (their output when no steps were sent) into steps
    steps(s: { kinds: RunKind[]; parse(lines: string[]): RunStep[] }): void;
    // extra fields for whoever starts a run over POST /api/runs, e.g. where a script should put its video
    onStart(fn: (run: Run, body: Record<string, unknown>) => Record<string, unknown> | void): void;
  };
  // a panel of this plugin's on a run's page, for these kinds (every kind when left out); the page gets ?run=<id>.
  // steps: the panel shows the run's steps itself, so the page leaves out its own list
  runPanel(p: { kinds?: RunKind[]; page: string; steps?: boolean }): void;
  // more things "Run something" offers for a worktree: list says what (asked each time the picker opens, kept
  // 30 seconds), start starts one of them by its id
  runOptions(o: { list(wt: RunTarget): Promise<RunOption[]>; start(id: string, wt: RunTarget): Promise<RunOptionStarted> }): void;
  // the indicator next to one of this plugin's screens in the sidebar; null clears it, and untilSeen drops it once
  // the screen is opened
  badge(screenId: string, b: Badge | null): void;
  // the active ones, which may come from other plugins
  providers: { tracker(): Tracker | undefined; codeHost(): CodeHost | undefined };
}
