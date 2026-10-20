import type { BurnPoint, DayActivity, StatusSpan, Ticket } from "@cockpit/shared";
import { costByDay, listSessions } from "./claude/sessions.ts";
import { config } from "./config.ts";
import { cached, db } from "./db.ts";
import { activeSprint, doneSet, isMine, myPrs, releasedSet, type Scope, sprints, sprintTickets, statusConfig, tracker } from "./providers.ts";
import { day, run, ticketOf } from "./util.ts";

type JiraTicket = Awaited<ReturnType<typeof sprintTickets>>[number];

const bucketList = () => Object.entries(statusConfig().buckets);

export function bucketOf(t: { status: string; statusCategory?: string }) {
  const buckets = bucketList();
  const hit = buckets.find(([, statuses]) => statuses.includes(t.status));
  if (hit) return hit[0];
  if (t.statusCategory === "done") return "Done";
  if (t.statusCategory === "new") return "To Do";
  return /block|hold/i.test(t.status) ? "Blocked" : "In Progress";
}

export function distribution(tickets: { status: string; statusCategory?: string; points?: number }[]) {
  const buckets = bucketList();
  const order = buckets.length ? buckets.map(([name]) => name) : ["Done", "Review", "In Progress", "To Do", "Blocked"];
  const out = new Map(order.map((name) => [name, { name, points: 0, count: 0 }]));
  for (const t of tickets) {
    const b = bucketOf(t);
    const row = out.get(b) ?? { name: b, points: 0, count: 0 };
    row.points += t.points ?? 0;
    row.count++;
    out.set(b, row);
  }
  return [...out.values()];
}

// Remaining points per day, counting down from the scope. The future stays empty.
export function burndown(points: BurnPoint[]) {
  const n = points.length;
  return points.map((p, i) => ({
    date: p.date,
    ideal: n > 1 ? +(p.scope - (p.scope * i) / (n - 1)).toFixed(2) : 0,
    remaining: Number.isNaN(p.released) ? null : +(p.scope - p.released).toFixed(2),
  }));
}

// Committed is everything in the sprint, completed is what reached a done status before the sprint ended.
export function sayDoOf(tickets: { status: string; points?: number; resolvedAt?: string; statusChangedAt?: string }[], end?: string, active = false) {
  const committed = tickets.reduce((n, t) => n + (t.points ?? 0), 0);
  const completed = tickets.reduce((n, t) => {
    if (!doneSet().has(t.status)) return n;
    const at = t.resolvedAt ?? t.statusChangedAt;
    return active || !end || !at || at <= end ? n + (t.points ?? 0) : n;
  }, 0);
  return { committed: +committed.toFixed(1), completed: +completed.toFixed(1) };
}

export async function sayDo(count = 6, scope: Scope = "team") {
  const list = (await sprints()).filter((s) => s.state !== "future" && s.start).sort((a, b) => a.start!.localeCompare(b.start!));
  const recent = list.slice(-count);
  return Promise.all(
    recent.map(async (s) => {
      const active = s.state === "active";
      const tickets = await sprintTickets(s.id, false, active ? undefined : 7 * 24 * 3600_000, scope);
      // compare ISO strings in one timezone
      const end = s.end ? new Date(s.end).toISOString() : undefined;
      const norm = tickets.map((t) => ({ ...t, resolvedAt: t.resolvedAt && new Date(t.resolvedAt).toISOString(), statusChangedAt: t.statusChangedAt && new Date(t.statusChangedAt).toISOString() }));
      return { id: s.id, name: s.name, active, ...sayDoOf(norm, end, active) };
    }),
  );
}

// --- snapshots -------------------------------------------------------------

const lastStatus = db.prepare<[string], { to_status: string; at: string }>("select to_status, at from transitions where key = ? order by at desc limit 1");
const addTransition = db.prepare("insert or ignore into transitions (key, from_status, to_status, at, source) values (?, ?, ?, ?, ?)");
const addSnapshot = db.prepare("insert or replace into snapshots (taken_at, sprint_id, key, status, points, in_sprint) values (?, ?, ?, ?, ?, 1)");

export function recordSnapshot(sprintId: number, tickets: JiraTicket[], now = new Date().toISOString()) {
  db.transaction(() => {
    for (const t of tickets) {
      addSnapshot.run(now, sprintId, t.key, t.status, t.points ?? null);
      const prev = lastStatus.get(t.key);
      if (!prev) {
        // first time we see it: Jira only tells us when the status category last changed
        addTransition.run(t.key, null, t.status, t.statusChangedAt ? new Date(t.statusChangedAt).toISOString() : now, "jira");
      } else if (prev.to_status !== t.status) {
        addTransition.run(t.key, prev.to_status, t.status, now, "snapshot");
      }
    }
  })();
}

export async function takeSnapshot() {
  const sprint = await activeSprint();
  if (!sprint) return;
  // force refreshes the same cache entry the report reads, so the report never fetches again after a sync
  recordSnapshot(sprint.id, await sprintTickets(sprint.id, true, undefined, "team"));
}

// only while a tracker with sprints is on; checked each time, since plugins come and go
export function startSnapshots() {
  const tick = () => (tracker()?.sprintTickets ? takeSnapshot().catch((e) => console.error("snapshot", e.message)) : undefined);
  setTimeout(tick, 10_000);
  setInterval(tick, config.report.snapshotMinutes * 60_000);
}

// --- sprint maths ----------------------------------------------------------

const isWorkday = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6;

export function workdays(start: Date, end: Date) {
  const out: string[] = [];
  const d = new Date(start);
  d.setHours(12, 0, 0, 0);
  while (d <= end) {
    if (isWorkday(d)) out.push(day(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export interface Transition {
  key: string;
  from?: string;
  to: string;
  at: string;
}

export function statusAt(history: Transition[], at: string) {
  let s: string | undefined;
  for (const t of history) if (t.at <= at) s = t.to;
  return s;
}

export function burnup(tickets: { key: string; points?: number }[], history: Map<string, Transition[]>, days: string[], today = day(new Date()), finished = releasedSet()): BurnPoint[] {
  const scope = tickets.reduce((n, t) => n + (t.points ?? 0), 0);
  return days.map((d, i) => {
    const end = `${d}T23:59:59.999Z`;
    const done = d > today ? NaN : tickets.reduce((n, t) => n + (finished.has(statusAt(history.get(t.key) ?? [], end) ?? "") ? (t.points ?? 0) : 0), 0);
    return { date: d, released: done, scope, ideal: days.length > 1 ? +((scope * i) / (days.length - 1)).toFixed(2) : scope };
  });
}

export function spans(key: string, history: Transition[], until = new Date().toISOString()): StatusSpan[] {
  return history.map((t, i) => ({ key, status: t.to, from: t.at, to: history[i + 1]?.at ?? (releasedSet().has(t.to) ? undefined : until) }));
}

function historyFor(keys: string[]) {
  const rows = db
    .prepare<[], { key: string; from_status: string | null; to_status: string; at: string }>("select * from transitions order by at")
    .all()
    .filter((r) => keys.includes(r.key));
  const map = new Map<string, Transition[]>();
  for (const r of rows) {
    const list = map.get(r.key) ?? [];
    list.push({ key: r.key, from: r.from_status ?? undefined, to: r.to_status, at: r.at });
    map.set(r.key, list);
  }
  return map;
}

// Where each person is against the even pace. The ideal share is the part of the sprint's workdays already gone.
export function people(tickets: { assignee?: string; status: string; points?: number }[]) {
  const by = new Map<string, { name: string; me: boolean; scope: number; done: number; tickets: number }>();
  for (const t of tickets) {
    const name = t.assignee ?? "Unassigned";
    const row = by.get(name) ?? { name, me: !!t.assignee && isMine(t), scope: 0, done: 0, tickets: 0 };
    row.scope += t.points ?? 0;
    if (doneSet().has(t.status)) row.done += t.points ?? 0;
    row.tickets++;
    by.set(name, row);
  }
  return [...by.values()].sort((a, b) => Number(b.me) - Number(a.me) || b.scope - a.scope);
}

// Tickets synced before we tracked them only know their last status change, which is better than nothing.
function withFallback(history: Map<string, Transition[]>, tickets: JiraTicket[]) {
  for (const t of tickets) {
    if (history.get(t.key)?.length) continue;
    const at = t.resolvedAt ?? t.statusChangedAt;
    if (at) history.set(t.key, [{ key: t.key, to: t.status, at: new Date(at).toISOString() }]);
  }
  return history;
}

export async function sprintReport(sprintId?: number, scope: Scope = "team") {
  const all = await sprints();
  const sprint = sprintId ? all.find((s) => s.id === sprintId) : await activeSprint();
  if (!sprint) return;

  const team = await sprintTickets(sprint.id, false, sprint.state === "closed" ? 7 * 24 * 3600_000 : undefined, "team");
  const tickets = scope === "team" ? team : team.filter(isMine);

  const keys = tickets.map((t) => t.key);
  const history = withFallback(historyFor(keys), tickets);
  const start = new Date(sprint.start ?? Date.now());
  const end = new Date(sprint.end ?? Date.now());
  const days = workdays(start, end);
  const points = burnup(tickets, history, days);
  const devDone = burnup(tickets, history, days, undefined, doneSet());

  const today = day(new Date());
  const elapsed = Math.max(1, days.filter((d) => d <= today).length);
  const doneNow = tickets.filter((t) => releasedSet().has(t.status)).reduce((n, t) => n + (t.points ?? 0), 0);
  const finishedNow = tickets.filter((t) => doneSet().has(t.status)).reduce((n, t) => n + (t.points ?? 0), 0);
  const scopePoints = tickets.reduce((n, t) => n + (t.points ?? 0), 0);
  const velocity = finishedNow / elapsed;

  // A ticket counts as added late when it showed up after the first snapshot of the sprint.
  // My tickets and the rest of the team started being tracked at different times, so each side has its own baseline.
  const firsts = new Map(
    db
      .prepare<[number], { key: string; first: string }>("select key, min(taken_at) first from snapshots where sprint_id = ? group by key")
      .all(sprint.id)
      .map((r) => [r.key, r.first]),
  );
  const baseline = (mine: boolean) =>
    team
      .filter((t) => isMine(t) === mine)
      .map((t) => firsts.get(t.key))
      .filter((f): f is string => !!f)
      .sort()[0];
  const base = { true: baseline(true), false: baseline(false) };
  const lateCut = (mine: boolean) => {
    const b = base[`${mine}`];
    return b ? new Date(Date.parse(b) + 2 * 3600_000).toISOString() : undefined;
  };
  const addedLate = tickets.filter((t) => {
    const cut = lateCut(isMine(t));
    const first = firsts.get(t.key);
    return cut && first && first > cut;
  }).map((t) => t.key);

  const sessions = listSessions({ limit: 5000 });
  const costs = new Map<string, number>();
  for (const s of sessions) if (s.ticket && s.costUSD) costs.set(s.ticket, (costs.get(s.ticket) ?? 0) + s.costUSD);

  return {
    sprint,
    tickets: tickets.map((t) => ({
      ...t,
      spans: spans(t.key, history.get(t.key) ?? []),
      costUSD: costs.get(t.key),
      addedLate: addedLate.includes(t.key),
    })),
    burnup: points,
    burndown: burndown(devDone),
    distribution: distribution(tickets),
    scope,
    people: people(team),
    elapsedShare: days.length ? +(days.filter((d) => d <= today).length / days.length).toFixed(3) : 0,
    totals: {
      scope: scopePoints,
      done: finishedNow,
      released: doneNow,
      projected: +(velocity * days.length).toFixed(1),
      daysLeft: days.filter((d) => d > today).length,
      daysTotal: days.length,
      byStatus: Object.fromEntries(statusConfig().statusOrder.map((s) => [s, tickets.filter((t) => t.status === s).reduce((n, t) => n + (t.points ?? 0), 0)])),
    },
    releasedStatuses: statusConfig().releasedStatuses,
    doneStatuses: [...doneSet()],
    statusOrder: statusConfig().statusOrder,
  };
}

// --- day by day ------------------------------------------------------------

const authorEmail = () =>
  cached("git:email", 24 * 3600_000, async () => (await run("git", ["-C", config.repo.path, "config", "user.email"]).catch(() => "")).trim());

async function commits(from: string, to: string) {
  if (!config.repo.path) return [];
  const email = await authorEmail();
  const out = await run("git", ["-C", config.repo.path, "log", "--all", `--author=${email}`, `--since=${from}T00:00`, `--until=${to}T23:59:59`, "--format=%h%x09%cI%x09%s"]).catch(() => "");
  const seen = new Set<string>();
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, at, subject] = l.split("\t");
      return { sha, at, subject, ticket: ticketOf(subject) };
    })
    .filter((c) => !seen.has(c.subject + c.at) && seen.add(c.subject + c.at));
}

export async function activity(from: string, to: string): Promise<DayActivity[]> {
  const [prs, cms] = await Promise.all([myPrs().catch(() => []), commits(from, to)]);
  const costs = costByDay(from, to);
  const sessions = new Map(listSessions({ limit: 5000 }).map((s) => [s.id, s]));
  const trans = db
    .prepare<[string, string], { key: string; from_status: string | null; to_status: string; at: string; source: string }>(
      "select * from transitions where at >= ? and at <= ? and source = 'snapshot' order by at",
    )
    .all(`${from}T00:00:00`, `${to}T23:59:59.999Z`);

  const out: DayActivity[] = [];
  const d = new Date(`${to}T12:00:00`);
  const stop = new Date(`${from}T12:00:00`);
  while (d >= stop) {
    const date = day(d);
    const c = costs.get(date);
    out.push({
      date,
      transitions: trans.filter((t) => day(t.at) === date).map((t) => ({ key: t.key, from: t.from_status ?? undefined, to: t.to_status, at: t.at })),
      prsOpened: prs.filter((p) => day(p.createdAt) === date),
      prsMerged: prs.filter((p) => p.mergedAt && day(p.mergedAt) === date),
      sessions: [...(c?.sessions ?? [])].map(([id, cost]) => ({ id, title: sessions.get(id)?.title, ticket: sessions.get(id)?.ticket, costUSD: +cost.toFixed(2) })),
      commits: cms.filter((x) => day(x.at) === date),
      costUSD: +(c?.cost ?? 0).toFixed(2),
    });
    d.setDate(d.getDate() - 1);
  }
  return out;
}

const prevWorkday = (d: Date) => {
  const p = new Date(d);
  do p.setDate(p.getDate() - 1);
  while (!isWorkday(p));
  return p;
};

export async function dailyText() {
  const today = new Date();
  const yesterday = prevWorkday(today);
  const [days, tickets] = await Promise.all([activity(day(yesterday), day(today)), sprintTickets().catch(() => [] as JiraTicket[])]);
  const y = days.filter((x) => x.date < day(today));
  const t = days.find((x) => x.date === day(today));
  const byKey = new Map(tickets.map((x) => [x.key, x]));
  const label = (key: string) => (byKey.get(key) ? `${key} ${byKey.get(key)!.summary}` : key);

  const lines: string[] = [];
  const did = (list: DayActivity[]) => {
    const out: string[] = [];
    for (const dd of list) {
      for (const tr of dd.transitions) out.push(`${label(tr.key)} moved to ${tr.to}`);
      for (const p of dd.prsMerged) out.push(`merged #${p.number} ${p.title}`);
      for (const p of dd.prsOpened) out.push(`opened #${p.number} ${p.title}`);
    }
    const worked = new Set(list.flatMap((dd) => [...dd.commits.map((c) => c.ticket), ...dd.sessions.map((s) => s.ticket)]).filter(Boolean) as string[]);
    for (const k of worked) if (!out.some((l) => l.includes(k))) out.push(`worked on ${label(k)}`);
    return out;
  };

  lines.push("Yesterday", ...did(y).map((l) => `- ${l}`));
  if (t) {
    const so = did([t]);
    if (so.length) lines.push("", "So far today", ...so.map((l) => `- ${l}`));
  }

  const active = tickets.filter((x) => ["In Progress", "Review", "QA"].includes(x.status));
  lines.push("", "Today", ...active.map((x) => `- ${x.key} ${x.summary} (${x.status})`));

  const blocked = tickets.filter((x) => /block|hold/i.test(x.status));
  lines.push("", "Blockers", ...(blocked.length ? blocked.map((x) => `- ${x.key} ${x.summary}`) : ["- none"]));

  return lines.join("\n");
}

export async function weekly() {
  const to = new Date();
  const from = new Date(Date.now() - 6 * 864e5);
  const days = await activity(day(from), day(to));
  const tickets = await sprintTickets().catch(() => [] as JiraTicket[]);
  const releasedKeys = new Set(days.flatMap((d) => d.transitions.filter((t) => releasedSet().has(t.to)).map((t) => t.key)));
  return {
    from: day(from),
    to: day(to),
    released: tickets.filter((t: Ticket) => releasedKeys.has(t.key)),
    prsMerged: days.flatMap((d) => d.prsMerged),
    prsOpened: days.flatMap((d) => d.prsOpened),
    commits: days.reduce((n, d) => n + d.commits.length, 0),
    costUSD: +days.reduce((n, d) => n + d.costUSD, 0).toFixed(2),
    sessions: days.reduce((n, d) => n + d.sessions.length, 0),
  };
}
