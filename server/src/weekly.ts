// The week in one page: what shipped, what's stuck, what the tokens went on and which sessions cost the most.
// It's there whenever you open it, and on the day and hour from Settings cockpit sends a notification about it.
import { board } from "./board.ts";
import { costByDay, listSessions } from "./claude/sessions.ts";
import { db } from "./db.ts";
import { notify } from "./notify.ts";
import { doneSet, myPrs, sprintTickets } from "./providers.ts";
import { getSettings, readRow, writeRow } from "./settings.ts";
import { day } from "./util.ts";

// Monday 00:00 local of the week that holds this date
export function weekStart(d = new Date()) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}

const DAY = 864e5;

function tokens(from: number, to: number) {
  const r = db
    .prepare<[string, string], { n: number | null; out: number | null }>("select sum(input + output + cache_write) n, sum(output) out from usage where ts >= ? and ts < ?")
    .get(new Date(from).toISOString(), new Date(to).toISOString());
  return { tokens: r?.n ?? 0, output: r?.out ?? 0 };
}

export async function weekly(start = weekStart()) {
  const from = start.getTime();
  const to = from + 7 * DAY;
  const inWeek = (iso?: string) => !!iso && Date.parse(iso) >= from && Date.parse(iso) < to;
  const showCost = getSettings().costs !== "hide";

  const [prs, tickets, cards] = await Promise.all([
    myPrs().catch(() => []),
    sprintTickets(undefined, false, undefined, "me").catch(() => []),
    from <= Date.now() && Date.now() < to ? board().catch(() => []) : Promise.resolve([]),
  ]);

  const done = doneSet();
  const shipped = {
    prs: prs.filter((p) => p.state === "MERGED" && inWeek(p.mergedAt)).map((p) => ({ number: p.number, title: p.title, url: p.url, ticket: p.ticket, at: p.mergedAt! })),
    tickets: tickets.filter((t) => done.has(t.status) && inWeek(t.statusChangedAt ?? t.resolvedAt)).map((t) => ({ key: t.key, summary: t.summary, status: t.status, url: t.url })),
  };

  // only this week has a live board; a past week's stuck work is gone by now
  const age = (ms: number) => Math.floor((Date.now() - ms) / DAY);
  const stuck = [
    ...cards.filter((c) => c.column === "needs").map((c) => ({ title: c.title, ticket: c.ticket, why: c.reason, days: age(c.updatedAt), card: c.id })),
    ...cards
      .filter((c) => c.column === "review" && c.pr && age(c.updatedAt) >= 3)
      .map((c) => ({ title: c.title, ticket: c.ticket, why: `${c.reason} for ${age(c.updatedAt)} days`, days: age(c.updatedAt), card: c.id })),
  ].sort((a, b) => b.days - a.days);

  const now = tokens(from, to);
  // the same stretch of the week before, so a Wednesday isn't compared with a whole week
  const before = tokens(from - 7 * DAY, Math.min(to, Date.now()) - 7 * DAY);
  const perDay = Array.from({ length: 7 }, (_, i) => ({ date: day(from + i * DAY + DAY / 2), ...tokens(from + i * DAY, from + (i + 1) * DAY) }));

  // the week's share of each session: its tokens in the week, and its cost delta over the week's days
  const used = db
    .prepare<[string, string], { session_id: string; n: number }>("select session_id, sum(input + output + cache_write) n from usage where ts >= ? and ts < ? and session_id is not null group by session_id")
    .all(new Date(from).toISOString(), new Date(to).toISOString());
  const costs = new Map<string, number>();
  for (const d of costByDay(day(from), day(to - DAY)).values()) for (const [id, c] of d.sessions) costs.set(id, (costs.get(id) ?? 0) + c);
  const sessions = new Map(listSessions({ limit: 100_000 }).map((s) => [s.id, s]));
  const rows = used.map((u) => {
    const s = sessions.get(u.session_id);
    return { id: u.session_id, title: s?.title ?? s?.name ?? u.session_id.slice(0, 8), ticket: s?.ticket, folder: s?.worktree ?? s?.cwd, tokens: u.n, costUSD: showCost ? +(costs.get(u.session_id) ?? 0).toFixed(2) : undefined };
  });
  const byTicket = new Map<string, { ticket: string; tokens: number; costUSD?: number; sessions: number }>();
  for (const r of rows) {
    if (!r.ticket) continue;
    const t = byTicket.get(r.ticket) ?? { ticket: r.ticket, tokens: 0, costUSD: showCost ? 0 : undefined, sessions: 0 };
    t.tokens += r.tokens;
    if (t.costUSD !== undefined) t.costUSD = +(t.costUSD + (r.costUSD ?? 0)).toFixed(2);
    t.sessions++;
    byTicket.set(r.ticket, t);
  }

  return {
    from: day(from),
    to: day(to - DAY),
    shipped,
    stuck,
    usage: { ...now, lastWeek: before.tokens, costUSD: showCost ? +[...costs.values()].reduce((a, b) => a + b, 0).toFixed(2) : undefined, perDay, sessions: rows.length },
    top: {
      sessions: rows.sort((a, b) => b.tokens - a.tokens).slice(0, 8),
      tickets: [...byTicket.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8),
    },
  };
}

// On the chosen day, once its hour has come: one notification a week with the headline numbers.
async function check() {
  const w = getSettings().weekly;
  if (!w.on) return;
  const now = new Date();
  if (now.getDay() !== w.day || now.getHours() < w.hour) return;
  const key = day(weekStart(now));
  if (readRow<string>("weekly-sent") === key) return;
  writeRow("weekly-sent", key);
  const d = await weekly();
  const shipped = d.shipped.prs.length;
  notify({
    title: "Your week in cockpit",
    body: `${shipped} ${shipped === 1 ? "PR" : "PRs"} merged, ${d.shipped.tickets.length} tickets done, ${d.stuck.length} stuck. ${(d.usage.tokens / 1e6).toFixed(1)}M tokens${d.usage.lastWeek ? `, ${d.usage.tokens >= d.usage.lastWeek ? "up" : "down"} from ${(d.usage.lastWeek / 1e6).toFixed(1)}M` : ""}.`,
    link: "/weekly",
    kind: "weekly",
  });
}

export function startWeekly() {
  setInterval(() => check().catch((e) => console.error("weekly", e)), 10 * 60_000);
}
