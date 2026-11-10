// Focus mode. Most notifications are a session finishing its turn, which can wait: while focus is on they go in a
// "Ready for you" stack (and the log, as always) instead of going off, and when it ends one summary goes out.
// Anything that needs you (a session waiting, a failure, a stuck or escalated one) still goes straight through.
import type { FocusState, HeldNote } from "@cockpit/shared";
import { broadcast } from "./hub.ts";
import { db } from "./db.ts";
import { getSettings, putSettings } from "./settings.ts";

db.exec(`
  create table if not exists held_notes (
    id integer primary key autoincrement,
    at integer not null,
    title text not null,
    body text not null,
    link text not null,
    node text
  );
`);

type Note = { title: string; body: string; link: string; kind?: string; node?: string };

export const FINISHED = "finished";
const MAX_MINUTES = 24 * 60;

const active = (f: { on: boolean; until: number }, now: number) => f.on && (!f.until || f.until > now);

// only a "finished" is held, and only while focus is on and holding is wanted
export function holding(n: { kind?: string; urgent?: boolean }, now = Date.now()) {
  if (n.kind !== FINISHED || n.urgent) return false;
  const s = getSettings();
  return s.alerts.holdFinished && active(s.focus, now);
}

export function hold(n: Note, now = Date.now()) {
  db.prepare("insert into held_notes (at, title, body, link, node) values (?, ?, ?, ?, ?)").run(now, n.title, n.body, n.link, n.node ?? null);
  broadcast({ type: "focus" });
}

const held = (from = 0) =>
  db
    .prepare<[number], HeldNote & { node: string | null }>("select id, at, title, body, link, node from held_notes where at >= ? order by at desc limit 100")
    .all(from)
    .map(({ node, ...h }) => (node ? { ...h, node } : h));

export function focusState(now = Date.now()): FocusState {
  const s = getSettings();
  const on = active(s.focus, now);
  return { on, since: s.focus.since, until: on ? s.focus.until : 0, holdFinished: s.alerts.holdFinished, held: held() };
}

// minutes, or none for until it's turned off. Starting again while on keeps when this block began.
export function startFocus(minutes?: number | null, now = Date.now()) {
  if (minutes != null && (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES)) throw new Error(`Focus for 1 to ${MAX_MINUTES} minutes`);
  const f = getSettings().focus;
  const since = active(f, now) ? f.since : now;
  putSettings({ focus: { on: true, since, until: minutes ? now + Math.round(minutes) * 60_000 : 0 } });
  broadcast({ type: "focus" });
  return focusState(now);
}

// the one notification for what waited, or none when nothing did
export function summary(notes: { title: string; body: string }[]): Note | undefined {
  if (!notes.length) return;
  const n = notes.length;
  const names = [...new Set(notes.map((x) => x.body || x.title))];
  return {
    title: `${n} ${n === 1 ? "session" : "sessions"} finished while you focused`,
    body: `${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}`,
    link: "/",
    kind: "focus",
  };
}

// ends a block, whether its time is up or it's turned off; returns the summary to send
export function endFocus(now = Date.now()) {
  const f = getSettings().focus;
  if (!f.on) return;
  putSettings({ focus: { on: false, since: f.since, until: 0 } });
  broadcast({ type: "focus" });
  // oldest first reads better in the summary
  return summary(held(f.since).reverse());
}

export const clearHeld = () => (db.prepare("delete from held_notes").run(), broadcast({ type: "focus" }));

// a block whose time ran out, here or while the server was down, ends on the next tick
export function startFocusWatch(send: (n: Note) => void) {
  const tick = () => {
    const f = getSettings().focus;
    if (!f.on || !f.until || f.until > Date.now()) return;
    const n = endFocus();
    if (n) send(n);
  };
  tick();
  setInterval(tick, 15_000).unref?.();
}
