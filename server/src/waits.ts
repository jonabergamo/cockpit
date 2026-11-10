// The waiting ledger: each stretch a session spent waiting on you (a permission prompt, a question, a menu), kept
// where the session runs, so My day can draw them and add up how long the agents waited.
import type { Session } from "@cockpit/shared";
import { db } from "./db.ts";

db.exec(`
  create table if not exists session_waits (
    id integer primary key autoincrement,
    session_id text not null,
    from_at integer not null,
    to_at integer,
    what text,
    seen_at integer not null
  );
  create index if not exists session_waits_from on session_waits (from_at);
`);

export interface Wait {
  session: string;
  from: number;
  // still waiting when it has none
  to?: number;
  what?: string;
}

// a prompt answered by a hook or a menu that flashed by isn't you keeping anyone waiting
const NOISE_MS = 5_000;
const TOUCH_MS = 60_000;

// the open ones by session. Stale ones were left open when cockpit last stopped
let open: Map<string, { id: number; from: number; seen: number; stale: boolean }> | undefined;
let touched = 0;

function load() {
  open ??= new Map(
    db
      .prepare<[], { id: number; session_id: string; from_at: number; seen_at: number }>("select id, session_id, from_at, seen_at from session_waits where to_at is null")
      .all()
      .map((r) => [r.session_id, { id: r.id, from: r.from_at, seen: r.seen_at, stale: true }]),
  );
  return open;
}

function close(w: { id: number; from: number }, at: number) {
  if (at - w.from < NOISE_MS) db.prepare("delete from session_waits where id = ?").run(w.id);
  else db.prepare("update session_waits set to_at = ? where id = ?").run(at, w.id);
}

// sessions is every live one on this machine; one that isn't waiting, or is gone, has stopped waiting
export function trackWaits(sessions: Pick<Session, "id" | "status" | "waitingFor" | "updatedAt">[], now = Date.now()) {
  const map = load();
  const waiting = new Map(sessions.filter((s) => s.status === "waiting").map((s) => [s.id, s]));
  for (const [id, w] of map) {
    if (waiting.has(id)) {
      w.stale = false;
      continue;
    }
    // one cockpit was down for stopped somewhere in between; when it was last seen waiting is the honest guess
    close(w, w.stale ? Math.max(w.from, w.seen) : now);
    map.delete(id);
  }
  for (const s of waiting.values()) {
    if (map.has(s.id)) continue;
    // a session already waiting when it's first seen has been since its last write
    const from = Math.min(now, s.updatedAt || now);
    const r = db.prepare("insert into session_waits (session_id, from_at, what, seen_at) values (?, ?, ?, ?)").run(s.id, from, s.waitingFor ?? null, now);
    map.set(s.id, { id: Number(r.lastInsertRowid), from, seen: now, stale: false });
  }
}

// what it wants, once the local model has read it off the screen
export function describeWait(sessionId: string, what: string) {
  const w = load().get(sessionId);
  if (w) db.prepare("update session_waits set what = ? where id = ?").run(what, w.id);
}

// the open ones are marked seen now and then, so a restart can close them near when they really ended
export function touchWaits(now = Date.now()) {
  if (now - touched < TOUCH_MS || !load().size) return;
  touched = now;
  db.prepare("update session_waits set seen_at = ? where to_at is null").run(now);
  for (const w of open!.values()) w.seen = now;
}

// the waits that overlap [from, to)
export function waitsBetween(from: number, to: number): Wait[] {
  return db
    .prepare<[number, number], { session_id: string; from_at: number; to_at: number | null; what: string | null }>(
      "select session_id, from_at, to_at, what from session_waits where from_at < ? and (to_at is null or to_at > ?) order by from_at",
    )
    .all(to, from)
    .map((r) => ({ session: r.session_id, from: r.from_at, to: r.to_at ?? undefined, what: r.what ?? undefined }));
}

// how long they waited inside [from, to), and the longest one
export function waitTotals(waits: Wait[], from: number, to: number, now = Date.now()) {
  let ms = 0;
  let longest: (Wait & { ms: number }) | undefined;
  for (const w of waits) {
    const d = Math.max(0, Math.min(w.to ?? now, to) - Math.max(w.from, from));
    ms += d;
    if (!longest || d > longest.ms) longest = { ...w, ms: d };
  }
  return { ms, longest };
}

// as after a restart: what is open is read back from the table
export const forgetOpen = () => void (open = undefined);
