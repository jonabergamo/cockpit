import type { CreateOptions, NewTicket, PrRef, PullRequest, Reviewer, StatusConfig, Ticket, TrackerSprint, TrackerTicket } from "@cockpit/shared";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { activeCodeHost, activeTracker, reviewSources } from "./plugins.ts";
import { readRow, writeRow } from "./settings.ts";

// What core asks of the tracker and code host, whichever plugins provide them. With none, the answers are
// empty, so the screens that need one hide and the rest carry on.
export const tracker = () => activeTracker()?.tracker;
export const codeHost = () => activeCodeHost()?.codeHost;

// The old [jira] section still counts until a tracker plugin says otherwise, which keeps tests and old setups working.
export function statusConfig(): StatusConfig {
  const t = tracker();
  if (t) return t.statusConfig();
  const j = config.jira;
  return { statusOrder: j.statusOrder, releasedStatuses: j.releasedStatuses, doneStatuses: j.doneStatuses, buckets: j.buckets };
}
export const releasedSet = () => new Set(statusConfig().releasedStatuses);
export const doneSet = () => {
  const s = statusConfig();
  return new Set(s.doneStatuses.length ? s.doneStatuses : s.releasedStatuses);
};
export const devDoneSet = () => new Set(statusConfig().doneStatuses);

export type Scope = "me" | "team";
export const isMine = (t: { assignee?: string }) => tracker()?.isMine(t) ?? (!config.jira.assignee || t.assignee === config.jira.assignee);
export const me = () => tracker()?.me?.();

export const myTickets = async (force = false): Promise<Ticket[]> => (await tracker()?.myTickets(force)) ?? [];
export const statusesOf = async (keys: string[], force = false): Promise<Ticket[]> => (keys.length ? ((await tracker()?.statusesOf(keys, force)) ?? []) : []);
export const searchTickets = async (query: string, force = false): Promise<Ticket[]> => (await tracker()?.search?.(query, force)) ?? [];
export async function assignToMe(key: string) {
  const t = tracker();
  if (!t?.assignToMe) throw Object.assign(new Error("the tracker in use can't assign tickets"), { status: 400 });
  await t.assignToMe(key);
}
export const createOptions = async (): Promise<CreateOptions | null> => (tracker()?.createTicket ? ((await tracker()?.createOptions?.()) ?? { types: [], presets: [], fields: [], sprint: false }) : null);
export async function createTicket(t: NewTicket) {
  const tr = tracker();
  if (!tr?.createTicket) throw Object.assign(new Error("The tracker in use can't create tickets"), { status: 400 });
  if (!t.summary?.trim()) throw Object.assign(new Error("Give the ticket a summary"), { status: 400 });
  return tr.createTicket({ ...t, summary: t.summary.trim() });
}
export const worktreeEpics = async (keys: string[], force = false) => (keys.length ? ((await tracker()?.worktreeEpics?.(keys, force)) ?? []) : []);
export async function epicInfo(key: string) {
  const t = tracker();
  if (!t?.epicInfo) throw Object.assign(new Error("the tracker in use has no epics"), { status: 400 });
  return t.epicInfo(key);
}

const saveSprint = db.prepare("insert or replace into sprints (id, name, start, end, goal, state) values (@id, @name, @start, @end, @goal, @state)");
// sprints are kept in the database too, for the say/do history
export async function sprints(): Promise<TrackerSprint[]> {
  const list = (await tracker()?.sprints?.()) ?? [];
  db.transaction(() => list.forEach((s) => saveSprint.run({ goal: null, start: null, end: null, ...s })))();
  return list;
}
export const activeSprint = async () => (await tracker()?.activeSprint?.()) ?? (await sprints()).find((s) => s.state === "active");

export const inStatusOn = (sprintId: number, statuses: string[], day: string) => tracker()?.inStatusOn?.(sprintId, statuses, day);

export async function sprintTickets(sprintId?: number, force = false, maxAge?: number, scope: Scope = "me"): Promise<TrackerTicket[]> {
  const all = (await tracker()?.sprintTickets?.(sprintId, force, maxAge)) ?? [];
  return scope === "team" ? all : all.filter(isMine);
}

// The last answers anyone got for these, so the sidebar badges can use them without asking the code host again.
// Undefined until something has asked since cockpit started.
const last: { prs?: PullRequest[]; queue?: PullRequest[] } = {};
export const knownPrs = () => last.prs;
export const knownQueue = () => last.queue;
let onKnown = () => {};
export const whenKnownChanges = (fn: () => void) => void (onKnown = fn);
const remember = <K extends keyof typeof last>(key: K, v: PullRequest[]) => {
  if (JSON.stringify(last[key]) !== JSON.stringify(v)) (last[key] = v), onKnown();
  return v;
};

// the code host's PRs, with whoever a review source put on them added to their reviewers
export const myPrs = async (fresh = false): Promise<PullRequest[]> => remember("prs", await prsWithReviewers(fresh));
async function prsWithReviewers(fresh: boolean): Promise<PullRequest[]> {
  const prs = (await codeHost()?.myPrs(fresh)) ?? [];
  const sources = reviewSources().filter((s) => s.reviewersOf);
  if (!sources.length || !prs.length) return prs;
  const extra = new Map<string, Reviewer[]>();
  await Promise.all(
    sources.map(async (s) => {
      const list = await s.reviewersOf!(fresh).catch(() => []);
      for (const { url, reviewers } of list) extra.set(url, [...(extra.get(url) ?? []), ...reviewers.map((r) => ({ ...r, source: r.source ?? s.name }))]);
    }),
  );
  return prs.map((p) => {
    const more = extra.get(p.url);
    if (!more) return p;
    const have = new Set((p.reviewers ?? []).map((r) => r.name.toLowerCase()));
    return { ...p, reviewers: [...(p.reviewers ?? []), ...more.filter((r) => !have.has(r.name.toLowerCase()))] };
  });
}
export const requestReview = async (n: number, logins: string[]) => {
  const h = codeHost();
  if (!h?.requestReview) throw Object.assign(new Error("the code host can't request reviews"), { status: 400 });
  return h.requestReview(n, logins);
};
/**
 * A PR can be waiting on you in more than one place at once, asked for on the
 * code host and tracked by a plugin as well, so the first mention of a url
 * wins. Oldest first, which is the order they should be dealt with in.
 */
export function mergeQueues(lists: PullRequest[][]): PullRequest[] {
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((p) => !seen.has(p.url) && seen.add(p.url))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** The code host's own queue plus anything the plugins add. */
export async function reviewQueue(fresh = false): Promise<PullRequest[]> {
  const lists = await Promise.all([
    codeHost()?.reviewQueue?.(fresh) ?? [],
    ...reviewSources().map(async (s) => {
      try {
        return await s.queue(fresh);
      } catch (e) {
        // One source being unreachable must not empty the whole screen.
        console.error(`review source ${s.name} failed:`, (e as Error).message);
        return [];
      }
    }),
  ]);
  return remember("queue", mergeQueues(lists));
}
export const deploys = async (since: string) => (await codeHost()?.deploys?.(since)) ?? [];
export const failingChecks = async (n: number) => (await codeHost()?.failingChecks?.(n)) ?? [];
export const reviewThreads = async (n: number) => (await codeHost()?.reviewThreads?.(n)) ?? [];
export const parsePr = (input: string): PrRef | undefined => codeHost()?.parsePr?.(input);

// PR reviews need these three from the code host
function reviewHost() {
  const h = codeHost();
  if (!h?.prInfo || !h.pendingReview) throw Object.assign(new Error("PR reviews need a code host plugin that supports them, like GitHub"), { status: 400 });
  return h as typeof h & Required<Pick<typeof h, "prInfo" | "pendingReview" | "deletePending">>;
}
export const prInfo = (ref: PrRef) => reviewHost().prInfo(ref);
export const pendingReview = (ref: PrRef) => reviewHost().pendingReview(ref);
export const deletePending = (ref: PrRef, id: number) => reviewHost().deletePending(ref, id);
// undefined when the code host can't say, or you haven't reviewed it before
export const lastReview = async (ref: PrRef) => (await codeHost()?.lastReview?.(ref)) ?? undefined;

// Setups from before plugins kept Jira and GitHub in config.toml. The first time, carry those over into the
// plugins' settings and turn them on, so nothing changes for them.
export function migrateLegacy() {
  const state = readRow<Record<string, { on?: boolean; settings?: Record<string, unknown> }>>("plugins") ?? {};
  let changed = false;
  if (!state.jira && config.jira.enabled && config.jira.board) {
    const j = config.jira;
    state.jira = {
      on: true,
      settings: { board: j.board, assignee: j.assignee, pointsField: j.pointsField, statusOrder: j.statusOrder, releasedStatuses: j.releasedStatuses, doneStatuses: j.doneStatuses, buckets: j.buckets, keyPattern: config.repo.keyPattern },
    };
    changed = true;
  }
  if (!state.github && config.github.enabled && config.github.repo) {
    state.github = { on: true, settings: { repo: config.github.repo } };
    changed = true;
  }
  if (!state.tailscale && config.allowedLogin) {
    state.tailscale = { on: true, settings: { login: config.allowedLogin } };
    changed = true;
  }
  if (changed) writeRow("plugins", state);
}
