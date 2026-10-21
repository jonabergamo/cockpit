import type { PullRequest, ReviewThread, Session, Sprint, Task, TermInfo, Ticket } from "./index.ts";
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
  settings?: SettingSpec[];
  requires?: Requirement[];
  // Claude Code skills the plugin relies on. One with a folder in the plugin's skills/ ships with it and Setup
  // can install it; one without is only checked for, e.g. a skill of your own.
  skills?: { name: string; required?: boolean }[];
}

export interface ScreenInfo {
  plugin: string;
  id: string;
  title: string;
  // URL of the page, served from the plugin's folder
  url: string;
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
  settings: Record<string, SettingValue>;
  screens: ScreenInfo[];
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
  | "notify"
  | "task.started"
  | "task.done"
  | "autopilot.acted"
  | "verify.done";

export interface RouteRequest {
  query: Record<string, string>;
  body: unknown;
  params: Record<string, string>;
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
  assignToMe?(key: string): Promise<void>;
  sprints?(): Promise<TrackerSprint[]>;
  activeSprint?(): Promise<TrackerSprint | undefined>;
  // every ticket in a sprint, the active one when no id, with points
  sprintTickets?(sprintId?: number, force?: boolean, maxAge?: number): Promise<TrackerTicket[]>;
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
  prInfo?(ref: PrRef): Promise<{ title: string; author: string; url: string; additions?: number; deletions?: number; changedFiles?: number; state?: string; isDraft?: boolean; headRefName?: string }>;
  pendingReview?(ref: PrRef): Promise<{ id: number; url: string; comments: number } | undefined>;
  deletePending?(ref: PrRef, id: number): Promise<unknown>;
}

// More PRs waiting for your review, from somewhere that is not the code host: a rota, a review board, a queue
// of your own. They join the code host's own queue on the PR reviews screen, deduplicated by url.
export interface ReviewSource {
  name: string;
  queue(fresh?: boolean): Promise<PullRequest[]>;
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

// The object a plugin's setup(k) gets. Everything it registers is dropped when the plugin turns off or reloads.
export interface Cockpit {
  readonly id: string;
  readonly dataDir: string;
  readonly assetsDir: string;
  setting<T = string>(key: string): T;
  log(...args: unknown[]): void;
  store: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void };
  // served at /api/plugins/<id>/x<path>; return JSON-able data, throw an Error with .status 400 for bad input
  route(method: "GET" | "POST" | "PUT" | "DELETE", path: string, handler: (req: RouteRequest) => unknown): void;
  // page is a file in the plugin folder, e.g. "assets/index.html"
  screen(s: { id: string; title: string; page: string }): void;
  theme(t: Theme): void;
  on(event: PluginEvent, fn: (data: unknown) => void): void;
  // runs a command with the plugin's env settings set (tokens and the like)
  run(cmd: string, args: string[], opts?: { cwd?: string; input?: string }): Promise<string>;
  // session ties the terminal to a Claude session it resumes
  terminal(t: { cwd: string; title?: string; command?: string; args?: string[]; session?: string }): TermInfo;
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
  // remembered in cockpit's cache table for maxAge ms; force fetches again. Keys are kept per plugin.
  cache<T>(key: string, maxAge: number, fn: () => Promise<T>, force?: boolean): Promise<T>;
  // finds a ticket key in branch names, titles and the like, with the active tracker's pattern
  ticketOf(...hay: (string | undefined)[]): string | undefined;
  tracker(t: Tracker): void;
  codeHost(h: CodeHost): void;
  // adds to the PR reviews queue without replacing the code host
  reviewSource(s: ReviewSource): void;
  access(a: AccessProvider): void;
  // the active ones, which may come from other plugins
  providers: { tracker(): Tracker | undefined; codeHost(): CodeHost | undefined };
}
