// What the sidebar shows next to each screen: a pulse while something runs, a number when something needs you.
// Only from what cockpit already holds: the runs table, terminals, live sessions, the Board and the PRs some
// screen last fetched, so a badge never costs a call to the code host or the tracker.
import type { Badge, BoardCard, PullRequest, Run, Session, TermInfo } from "@cockpit/shared";
import { board } from "./board.ts";
import { listSessions } from "./claude/sessions.ts";
import { broadcast, tap } from "./hub.ts";
import { knownQueue, whenKnownChanges } from "./providers.ts";
import { listTerms } from "./pty.ts";
import { reviewStates } from "./reviews.ts";
import { failureIsNews, listRuns } from "./runs.ts";
import { readRow, writeRow } from "./settings.ts";

const SEEN = "badges-seen";
const DAY = 24 * 3600_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clean = (b: Omit<Badge, "title">, parts: (string | number | false | undefined)[]): Badge | undefined => {
  const out = Object.fromEntries(Object.entries(b).filter(([, v]) => !!v)) as Omit<Badge, "title">;
  return Object.keys(out).length ? { ...out, title: parts.filter(Boolean).join(" · ") } : undefined;
};

// set by plugins with k.badge, by nav id (plugin:<id>/<screen>)
const fromPlugins = new Map<string, Badge>();
const count = (n: unknown) => (typeof n === "number" && n > 0 ? Math.floor(n) : undefined);
export function setPluginBadge(plugin: string, screen: string, b: Badge | null) {
  const id = `plugin:${plugin}/${screen}`;
  const shown = b && clean({ live: count(b.live), attention: count(b.attention), failed: count(b.failed), count: count(b.count) }, [String(b.title ?? "")]);
  if (shown) fromPlugins.set(id, { ...shown, untilSeen: b.untilSeen === true || undefined });
  else fromPlugins.delete(id);
  badgesChanged();
}
export function clearPluginBadges(plugin: string) {
  const mine = [...fromPlugins.keys()].filter((id) => id.startsWith(`plugin:${plugin}/`));
  mine.forEach((id) => fromPlugins.delete(id));
  if (mine.length) badgesChanged();
}

// when each screen with a "since you last looked" count was last opened
const seenAt = (id: string) => readRow<Record<string, number>>(SEEN)?.[id];
export function markSeen(id: string, now = Date.now()) {
  writeRow(SEEN, { ...readRow<Record<string, number>>(SEEN), [id]: now });
  if (fromPlugins.get(id)?.untilSeen) fromPlugins.delete(id);
}

export interface BadgeInput {
  runs: Pick<Run, "status" | "source" | "meta" | "endedAt">[];
  // runs that failed after this are new to you
  runsSeen: number;
  terms: TermInfo[];
  sessions: Pick<Session, "id" | "pid" | "status">[];
  cards: Pick<BoardCard, "column">[];
  // undefined while nothing has fetched it yet
  queue?: Pick<PullRequest, "url">[];
  reviews: { url: string; status: string }[];
  plugins: Record<string, Badge>;
}

// pure, so it can be tested on made-up state
export function badgesOf(i: BadgeInput): Record<string, Badge> {
  const out: Record<string, Badge | undefined> = {};

  const running = i.runs.filter((r) => r.status === "running").length;
  const failed = i.runs.filter((r) => failureIsNews(r) && (r.endedAt ?? 0) > i.runsSeen).length;
  out["/runs"] = clean({ live: running, failed }, [running && `${plural(running, "run")} going`, failed && `${failed} failed since you last looked`]);

  // tabs, as the Terminals screen shows them: split shells sit under their terminal
  const open = i.terms.filter((t) => t.exited === undefined);
  const tabs = open.filter((t) => !t.parent || !open.some((p) => p.id === t.parent));
  const inTerms = open.flatMap((t) => i.sessions.find((s) => s.id === t.session || (!!t.pid && s.pid === t.pid)) ?? []);
  const termBusy = inTerms.filter((s) => s.status === "busy").length;
  const termWaiting = inTerms.filter((s) => s.status === "waiting").length;
  out["/terminals"] = clean({ count: tabs.length, live: termBusy, attention: termWaiting }, [
    tabs.length && `${plural(tabs.length, "terminal")} open`,
    termBusy && `Claude working in ${termBusy}`,
    termWaiting && `${termWaiting} waiting for you`,
  ]);

  const needs = i.cards.filter((c) => c.column === "needs").length;
  const working = i.cards.filter((c) => c.column === "working").length;
  out["/board"] = clean({ attention: needs, live: working }, [needs && `${needs} need${needs === 1 ? "s" : ""} you`, working && `${working} working`]);

  // the same queue as "Waiting for your review": requests you haven't started a review of
  const reviewed = new Set(i.reviews.map((r) => r.url));
  const asked = (i.queue ?? []).filter((p) => !reviewed.has(p.url)).length;
  const writing = i.reviews.filter((r) => r.status === "running").length;
  const answer = i.reviews.filter((r) => r.status === "waiting").length;
  out["/reviews"] = clean({ attention: asked + answer, live: writing }, [
    asked && `${plural(asked, "PR")} waiting for your review`,
    writing && `${plural(writing, "review")} being written`,
    answer && `${plural(answer, "review")} waiting for you`,
  ]);

  const busy = i.sessions.filter((s) => s.status === "busy").length;
  const waiting = i.sessions.filter((s) => s.status === "waiting").length;
  out["/sessions"] = clean({ live: busy, attention: waiting }, [busy && `${plural(busy, "session")} working`, waiting && `${waiting} waiting for you`]);

  for (const [id, b] of Object.entries(i.plugins)) out[id] = b;
  return Object.fromEntries(Object.entries(out).filter((e): e is [string, Badge] => !!e[1]));
}

export async function computeBadges(now = Date.now()): Promise<Record<string, Badge>> {
  let runsSeen = seenAt("/runs");
  // a first look counts nothing that failed before badges existed
  if (runsSeen === undefined) markSeen("/runs", (runsSeen = now));
  const runs = [...listRuns({ status: "running" }), ...listRuns({ status: "fail", since: runsSeen - DAY, limit: 500 })];
  const [cards, reviews] = await Promise.all([board({ offline: true }).catch(() => []), reviewStates().catch(() => [])]);
  return badgesOf({
    runs,
    runsSeen,
    terms: listTerms(),
    sessions: listSessions({ liveOnly: true }),
    cards,
    queue: knownQueue(),
    reviews,
    plugins: Object.fromEntries(fromPlugins),
  });
}

let current: Record<string, Badge> | undefined;
let last = "";
export async function badges() {
  return (current ??= await computeBadges());
}

async function push() {
  current = await computeBadges();
  const json = JSON.stringify(current);
  if (json === last) return;
  last = json;
  broadcast({ type: "badges", badges: current });
}

let pending: NodeJS.Timeout | undefined;
// a burst of changes becomes one look and, when something moved, one message
export function badgesChanged() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = undefined;
    push().catch((e) => console.error("badges", e));
  }, 500);
}

export async function seen(id: string) {
  markSeen(id);
  await push();
  return current!;
}

// what moves a badge is already pushed to the app, so follow that, plus the PR lists when a screen fetches them
const MOVES = new Set(["run", "terms", "sessions", "session.update", "board", "plugins"]);
export function startBadges() {
  tap((ev) => MOVES.has(ev.type) && badgesChanged());
  whenKnownChanges(badgesChanged);
  badgesChanged();
}
