// Wrap-up and pick-up: at the end of the day, a line per live session saying what's next, with its uncommitted
// files and how far its branch is from upstream; the next morning Today shows them until you dismiss them, with a
// way back into each session. What a session said and its git state are read where it runs; the set is kept here.
import type { Entry, Session } from "@cockpit/shared";
import { randomUUID } from "node:crypto";
import { tailEntries } from "./claude/entries.ts";
import { listSessions } from "./claude/sessions.ts";
import { db } from "./db.ts";
import { firstWords } from "./away.ts";
import { myPrs } from "./providers.ts";
import { oneLine, quick } from "./quick.ts";
import { onNode } from "./remote/sessions.ts";
import { getSettings } from "./settings.ts";
import { day, run } from "./util.ts";

db.exec(`
  create table if not exists handoffs (
    id text primary key,
    day text not null,
    session_id text not null,
    node text,
    term text,
    title text not null,
    ticket text,
    pr text,
    branch text,
    cwd text,
    next text not null,
    dirty integer not null default 0,
    ahead integer not null default 0,
    behind integer not null default 0,
    created_at integer not null,
    saved integer not null default 0,
    dismissed_at integer
  );
  create index if not exists handoffs_day on handoffs (day);
`);

export interface Handoff {
  id: string;
  day: string;
  session: string;
  node?: string;
  term?: string;
  title: string;
  ticket?: string;
  pr?: string;
  branch?: string;
  cwd?: string;
  next: string;
  dirty: number;
  ahead: number;
  behind: number;
  createdAt: number;
}

// what the machine a session runs on knows about it
export interface Where {
  last?: string;
  branch?: string;
  dirty: number;
  ahead: number;
  behind: number;
  ticket?: string;
}

// the work day starts at 5, so a wrap-up after midnight still belongs to the day it ends
const ROLLOVER_H = 5;
export const workDay = (at = Date.now()) => day(at - ROLLOVER_H * 3600_000);

// `git status --short --branch`: "## main...origin/main [ahead 2, behind 1]" then a line per changed file
export function parseStatus(out: string) {
  const lines = out.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift()! : "";
  const branch = head.slice(3).split("...")[0].replace(/^No commits yet on /, "").trim() || undefined;
  return { branch: branch === "HEAD (no branch)" ? undefined : branch, dirty: lines.length, ahead: Number(head.match(/ahead (\d+)/)?.[1] ?? 0), behind: Number(head.match(/behind (\d+)/)?.[1] ?? 0) };
}

export const lastSaid = (entries: Entry[]) => entries.findLast((e): e is Extract<Entry, { kind: "assistant" }> => e.kind === "assistant" && !!e.text.trim())?.text.trim();

const linkFor = db.prepare<[string], { ticket: string }>("select ticket from links where worktree = ?");

// on the machine the session runs on
export async function whereHere(s: { id: string; agent?: string; cwd?: string; worktree?: string }): Promise<Where> {
  const dir = s.worktree ?? s.cwd;
  const [got, st] = await Promise.all([tailEntries(s.id, s.agent, 2 * 1024 * 1024).catch(() => undefined), dir ? run("git", ["-C", dir, "status", "--short", "--branch"], { timeout: 15_000 }).catch(() => "") : Promise.resolve("")]);
  return { last: lastSaid(got?.entries ?? []), ...parseStatus(st), ticket: s.worktree ? linkFor.get(s.worktree)?.ticket : undefined };
}

const files = (n: number) => `${n} uncommitted ${n === 1 ? "file" : "files"}`;

// without a local model: the first sentence of what it said last, and what's left uncommitted
export function fallbackNext(w: Pick<Where, "last" | "dirty">) {
  const said = firstWords(w.last);
  const dirty = w.dirty ? files(w.dirty) : "";
  return [said, dirty].filter(Boolean).join(" · ") || "Pick it up where it stopped";
}

async function nextStep(title: string, w: Where) {
  if (!w.last) return fallbackNext(w);
  const state = [w.dirty ? files(w.dirty) : "", w.ahead ? `${w.ahead} commits not pushed` : ""].filter(Boolean).join(", ");
  const said = await quick(
    `A coding agent is stopping for the day on "${title}"${state ? ` (${state})` : ""}. From what it said last, write the one next step to take tomorrow, as a short imperative line. Reply with the line only.\n\n${w.last.slice(0, 3000)}`,
    { max: 40, timeoutMs: 10_000 },
  );
  return oneLine(said) ?? fallbackNext(w);
}

async function whereOf(s: Session): Promise<Where> {
  return onNode(
    s.id,
    // a node from before this asks for the transcript the old way, and its git state is left out
    (n) =>
      n.request<Where>("session.wrap", { id: s.id, agent: s.agent }).catch(async () => {
        const got = await n.request<{ entries: Entry[] } | null>("session.entries", { id: s.id, agent: s.agent, bytes: 2 * 1024 * 1024 }).catch(() => null);
        return { last: lastSaid(got?.entries ?? []), dirty: 0, ahead: 0, behind: 0 };
      }),
    () => whereHere(s),
  );
}

const row = (r: Record<string, any>): Handoff => ({
  id: r.id,
  day: r.day,
  session: r.session_id,
  node: r.node ?? undefined,
  term: r.term ?? undefined,
  title: r.title,
  ticket: r.ticket ?? undefined,
  pr: r.pr ?? undefined,
  branch: r.branch ?? undefined,
  cwd: r.cwd ?? undefined,
  next: r.next,
  dirty: r.dirty,
  ahead: r.ahead,
  behind: r.behind,
  createdAt: r.created_at,
});

// A draft for every live session, kept as today's set (a second wrap-up replaces it). It shows the next day once saved.
export async function wrap(): Promise<Handoff[]> {
  const live = listSessions({ liveOnly: true, limit: 500 });
  const prs = live.length ? await myPrs().catch(() => []) : [];
  const today = workDay();
  const now = Date.now();
  const drafts = await Promise.all(
    live.map(async (s): Promise<Handoff> => {
      const w = await whereOf(s).catch((): Where => ({ dirty: 0, ahead: 0, behind: 0 }));
      const title = s.title || s.name || s.cwd.split("/").pop() || "Session";
      const branch = w.branch ?? s.branch;
      const ticket = s.ticket ?? w.ticket;
      const pr = prs.find((p) => (branch && p.branch === branch) || (ticket && p.ticket === ticket))?.url;
      return { id: randomUUID(), day: today, session: s.id, node: s.node, term: s.term, title, ticket, pr, branch, cwd: s.worktree ?? s.cwd, next: await nextStep(title, w), dirty: w.dirty, ahead: w.ahead, behind: w.behind, createdAt: now };
    }),
  );
  const add = db.prepare(
    "insert into handoffs (id, day, session_id, node, term, title, ticket, pr, branch, cwd, next, dirty, ahead, behind, created_at) values (@id, @day, @session, @node, @term, @title, @ticket, @pr, @branch, @cwd, @next, @dirty, @ahead, @behind, @createdAt)",
  );
  db.transaction(() => {
    db.prepare("delete from handoffs where day = ?").run(today);
    for (const d of drafts) add.run({ ...d, node: d.node ?? null, term: d.term ?? null, ticket: d.ticket ?? null, pr: d.pr ?? null, branch: d.branch ?? null, cwd: d.cwd ?? null });
  })();
  return drafts;
}

// your edits to the drafts; the ones you left out don't carry over
export function saveWrap(items: { id: string; next: string }[]) {
  const today = workDay();
  const keep = new Map(items.filter((i) => i.next?.trim()).map((i) => [i.id, i.next.trim()]));
  const set = db.prepare("update handoffs set next = ?, saved = 1 where id = ? and day = ?");
  db.transaction(() => {
    for (const [id, next] of keep) set.run(next, id, today);
    db.prepare(`delete from handoffs where day = ? and saved = 0`).run(today);
  })();
  return keep.size;
}

// what's left from earlier days, newest first; older than the setting's days is gone from view
export function pickUp(now = Date.now()): Handoff[] {
  const since = now - getSettings().handoff.keepDays * 24 * 3600_000;
  return db
    .prepare("select * from handoffs where saved = 1 and dismissed_at is null and day < ? and created_at >= ? order by created_at desc, title")
    .all(workDay(now), since)
    .map((r) => row(r as Record<string, any>));
}

export const dismiss = (ids: string[]) => {
  const at = Date.now();
  const set = db.prepare("update handoffs set dismissed_at = ? where id = ?");
  db.transaction(() => ids.forEach((id) => set.run(at, id)))();
};
