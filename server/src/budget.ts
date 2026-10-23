// What each ticket's Claude sessions have used, against a budget: one default for every ticket from Settings,
// or one set on the ticket itself. Crossing the warning level and then the budget each notify once.
// It counts dollars, or tokens when costs are hidden (on a plan the dollars mean little). Tokens are the new
// ones, input, output and cache writes; cache reads would dwarf them and cost next to nothing.
import type { TicketSpend } from "@cockpit/shared";
import { listSessions } from "./claude/sessions.ts";
import { db } from "./db.ts";
import { notify } from "./notify.ts";
import { getSettings, readRow, writeRow } from "./settings.ts";

type Unit = TicketSpend["unit"];

interface Use {
  usd: number;
  tokens: number;
  sessions: number;
  lastAt: number;
}

export const unitOf = (): Unit => (getSettings().costs === "hide" ? "tokens" : "usd");
const row = (unit: Unit) => (unit === "usd" ? "budgets" : "budgets-tokens");
const toldRow = (unit: Unit) => `budget-told-${unit}`;
const overrides = (unit: Unit) => readRow<Record<string, number>>(row(unit)) ?? {};

// usd in dollars, tokens in tokens; null goes back to the default
export function setBudget(ticket: string, amount: number | null, unit = unitOf()) {
  const all = overrides(unit);
  if (amount === null) delete all[ticket];
  else all[ticket] = Math.max(0, amount);
  writeRow(row(unit), all);
  // a new limit is a new line to cross
  const told = readRow<Record<string, number>>(toldRow(unit)) ?? {};
  delete told[ticket];
  writeRow(toldRow(unit), told);
}

// 0 means no budget, also when it's the override
function limitOf(ticket: string, unit: Unit, all: Record<string, number>) {
  const b = getSettings().budget;
  const n = ticket in all ? all[ticket] : unit === "usd" ? b.perTicketUSD : b.perTicketMTokens * 1e6;
  return n > 0 ? n : undefined;
}

const tokensBySession = () =>
  new Map(
    db
      .prepare<[], { session_id: string; n: number }>("select session_id, sum(input + output + cache_write) n from usage where session_id is not null group by session_id")
      .all()
      .map((r) => [r.session_id, r.n]),
  );

// what these sessions used together, in the unit that's showing
export function sessionsSpend(ids: string[], unit = unitOf()) {
  if (!ids.length) return 0;
  const want = new Set(ids);
  if (unit === "tokens") {
    const tokens = tokensBySession();
    return ids.reduce((n, id) => n + (tokens.get(id) ?? 0), 0);
  }
  return +listSessions({ limit: 100_000 })
    .filter((s) => want.has(s.id))
    .reduce((n, s) => n + (s.costUSD ?? 0), 0)
    .toFixed(2);
}

function usage(): Map<string, Use> {
  const tokens = tokensBySession();
  const out = new Map<string, Use>();
  for (const s of listSessions({ limit: 100_000 })) {
    if (!s.ticket) continue;
    const n = tokens.get(s.id) ?? 0;
    if (!s.costUSD && !n) continue;
    const t = out.get(s.ticket) ?? { usd: 0, tokens: 0, sessions: 0, lastAt: 0 };
    t.usd += s.costUSD ?? 0;
    t.tokens += n;
    t.sessions++;
    t.lastAt = Math.max(t.lastAt, s.updatedAt);
    out.set(s.ticket, t);
  }
  return out;
}

// every ticket that used something, in the unit that's showing
export function ticketSpend(): Map<string, TicketSpend & { sessions: number; lastAt: number }> {
  const unit = unitOf();
  const all = overrides(unit);
  const { warnPct } = getSettings().budget;
  const out = new Map<string, TicketSpend & { sessions: number; lastAt: number }>();
  for (const [key, u] of usage()) out.set(key, { spent: unit === "usd" ? +u.usd.toFixed(2) : u.tokens, limit: limitOf(key, unit, all), unit, warnPct, sessions: u.sessions, lastAt: u.lastAt });
  for (const key of Object.keys(all)) if (!out.has(key)) out.set(key, { spent: 0, limit: limitOf(key, unit, all), unit, warnPct, sessions: 0, lastAt: 0 });
  return out;
}

export const budgets = () => ({ ...getSettings().budget, unit: unitOf(), tickets: Object.fromEntries(ticketSpend()) });

// 0 under the warning, the warning percentage past it, 100 past the budget
export const levelOf = (spent: number, limit: number, warnPct: number) => (spent >= limit ? 100 : spent >= (limit * warnPct) / 100 ? warnPct : 0);

export const amount = (n: number, unit: Unit) => (unit === "usd" ? `$${n.toFixed(2)}` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tokens` : `${Math.round(n / 1e3)}k tokens`);

function check() {
  const unit = unitOf();
  const told = readRow<Record<string, number>>(toldRow(unit)) ?? {};
  let changed = false;
  for (const [key, t] of ticketSpend()) {
    if (!t.limit) continue;
    const level = levelOf(t.spent, t.limit, t.warnPct);
    if (level <= (told[key] ?? 0)) continue;
    told[key] = level;
    changed = true;
    // old tickets already past a budget you just set are noted quietly, only live work is news
    if (Date.now() - t.lastAt > 3600_000) continue;
    notify({
      title: level === 100 ? `${key} is over its budget` : `${key} has used ${t.warnPct}% of its budget`,
      body: `${amount(t.spent, unit)} of ${amount(t.limit, unit)} across ${t.sessions} ${t.sessions === 1 ? "session" : "sessions"}`,
      link: `/tickets?key=${encodeURIComponent(key)}`,
    });
  }
  if (changed) writeRow(toldRow(unit), told);
}

export function startBudgetWatch() {
  setInterval(check, 60_000);
}
