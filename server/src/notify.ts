import type { Session } from "@cockpit/shared";
import { broadcast } from "./hub.ts";
import { emit } from "./events.ts";
import { db } from "./db.ts";
import { listTerms } from "./pty.ts";
import { getSettings } from "./settings.ts";

const shortPath = (p: string) => (process.env.HOME ? p.replace(process.env.HOME, "~") : p);

// Everything worth telling you also goes in a log, for "while you were away"
export function logEvent(kind: string, title: string, body?: string, link?: string, ref?: string) {
  db.prepare("insert into events_log (at, kind, title, body, link, ref) values (?, ?, ?, ?, ?, ?)").run(Date.now(), kind, title, body ?? null, link ?? null, ref ?? null);
}

let seq = 0;
// urgent ones are a second nudge for something that has waited a long time; push plugins send them loudly
export function notify(n: { title: string; body: string; link: string; urgent?: boolean; kind?: string }) {
  broadcast({ type: "notify", id: ++seq, title: n.title, body: n.body, link: n.link });
  emit("notify", n);
  logEvent(n.kind ?? "notify", n.title, n.body, n.link);
}

// A session going from working to waiting is the moment it needs you: a finished review or call, a question,
// a permission prompt. Reviews get named after their terminal.
const last = new Map<string, string>();
export function sessionsChanged(sessions: Session[]) {
  const seen = new Set<string>();
  const terms = listTerms();
  for (const s of sessions) {
    seen.add(s.id);
    const before = last.get(s.id);
    last.set(s.id, s.status);
    if (before === undefined) emit("session.started", s);
    if (s.status === "idle" && before === "busy") emit("session.idle", s);
    // a quick first answer can start and finish between two polls, so a new session already waiting on a
    // prompt it was given counts too
    const finishedFirst = before === undefined && !!s.title && Date.now() - s.startedAt < 60_000;
    if (s.status !== "idle" || !(before === "busy" || finishedFirst)) continue;
    const term = terms.find((t) => t.session === s.id || (!!s.pid && t.pid === s.pid));
    const what = term?.title.startsWith("review #") ? `${term.title.replace(/^review/, "Review")} is ready` : "Claude is waiting";
    notify({ title: what, body: s.title ?? shortPath(s.cwd), link: `/terminals?resume=${s.id}${s.pid ? `&pid=${s.pid}` : ""}` });
  }
  for (const id of last.keys()) {
    if (seen.has(id)) continue;
    last.delete(id);
    waitingSince.delete(id);
    emit("session.ended", { id });
  }
}

// A session left waiting gets one more, urgent nudge after a while; a phone push plugin sends that one loudly.
const waitingSince = new Map<string, { at: number; nudged: boolean }>();
export function escalate(sessions: Session[]) {
  const minutes = getSettings().alerts.escalateMinutes;
  for (const s of sessions) {
    if (s.status !== "idle") {
      waitingSince.delete(s.id);
      continue;
    }
    // timed from when it went idle; ones already overdue when cockpit starts don't all go off at once
    const w = waitingSince.get(s.id) ?? { at: s.updatedAt, nudged: Date.now() - s.updatedAt > minutes * 60_000 };
    waitingSince.set(s.id, w);
    if (!minutes || w.nudged || Date.now() - w.at < minutes * 60_000) continue;
    w.nudged = true;
    notify({ title: `Still waiting: ${s.title ?? s.name ?? shortPath(s.cwd)}`, body: `Claude has been waiting for you for ${minutes} minutes.`, link: `/sessions/${s.id}`, urgent: true });
  }
}

// Once per 5h window, when usage crosses 80%.
let warnedFor = 0;
export function limitsChanged(fivePct: number, resetsAt: number) {
  if (fivePct < 80 || warnedFor === resetsAt) return;
  warnedFor = resetsAt;
  const left = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60_000));
  notify({ title: `${Math.round(fivePct)}% of the 5 hour limit used`, body: `It resets in ${left >= 60 ? `${Math.floor(left / 60)}h ${left % 60}m` : `${left}m`}.`, link: "/usage" });
}
