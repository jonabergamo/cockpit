import type { Session } from "@cockpit/shared";
import { broadcast } from "./hub.ts";
import { emit } from "./events.ts";
import { db } from "./db.ts";
import { listTerms } from "./pty.ts";
import { getSettings } from "./settings.ts";
import { config } from "./config.ts";
import { enqueue } from "./remote/outbox.ts";
import { capture } from "./agents.ts";
import { oneLine, quick, quickOn } from "./quick.ts";

// a node has nobody looking at it: what it would show goes to its hub, which shows it once it has it
const relay = config.role === "node";

const shortPath = (p: string) => (process.env.HOME ? p.replace(process.env.HOME, "~") : p);

// Everything worth telling you also goes in a log, for "while you were away"
// at is when it happened, for what a node did while the hub was away
export function logEvent(kind: string, title: string, body?: string, link?: string, ref?: string, at = Date.now()) {
  if (relay) return enqueue("log", { kind, title, body, link, ref });
  db.prepare("insert into events_log (at, kind, title, body, link, ref) values (?, ?, ?, ?, ?, ?)").run(at, kind || "notify", title || "(untitled)", body ?? null, link ?? null, ref ?? null);
}

let seq = 0;
// urgent ones are a second nudge for something that has waited a long time; push plugins send them loudly
// node is the machine it happened on, when that's not this one
export function notify(n: { title: string; body: string; link: string; urgent?: boolean; kind?: string; node?: string }) {
  // a plugin put here (a phone push, say) still hears it, so it can go out while the hub sleeps
  if (relay) return enqueue("notify", n), emit("notify", n);
  broadcast({ type: "notify", id: ++seq, title: n.title, body: n.node ? `${n.body} · on ${n.node}` : n.body, link: n.link });
  emit("notify", n);
  logEvent(n.kind ?? "notify", n.title, n.body, n.link);
}

// A session asking a question, showing a permission prompt or a dialog is the moment it needs you. One that
// just finishes its turn gets a quieter "finished". Reviews get named after their terminal.
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
    if (s.status === "waiting" && before !== "waiting") emit("session.waiting", s);
    // a quick first answer can start and finish between two polls, so a new session that already did counts too
    const fresh = before === undefined && !!s.title && Date.now() - s.startedAt < 60_000;
    const link = `/terminals?resume=${s.id}${s.pid ? `&pid=${s.pid}` : ""}`;
    const body = s.title ?? shortPath(s.cwd);
    if (s.status === "waiting" && before !== "waiting" && (before !== undefined || fresh)) {
      const send = (what?: string) => {
        if (what) wants.set(s.id, what);
        const why = what ?? s.waitingFor;
        notify({ title: s.waitingFor === "input needed" ? "Claude needs your input" : "Claude is waiting for you", body: why ? `${body} · ${why}` : body, link });
      };
      if (quickOn()) void whatItWants(s.id).then(send, () => send());
      else send();
      continue;
    }
    if (s.status !== "idle" || !(before === "busy" || fresh)) continue;
    const term = terms.find((t) => t.session === s.id || (!!s.pid && t.pid === s.pid));
    const what = term?.title.startsWith("review #") ? `${term.title.replace(/^review/, "Review")} is ready` : "Claude finished";
    notify({ title: what, body, link });
  }
  for (const id of last.keys()) {
    if (seen.has(id)) continue;
    last.delete(id);
    waitingSince.delete(id);
    wants.delete(id);
    emit("session.ended", { id });
  }
}

// What a waiting session wants, read off its screen by the local model: "wants to run pnpm db:reset" says more
// than "waiting". Given a few seconds at most, so a model still loading doesn't hold the notification up.
const wants = new Map<string, string>();
async function whatItWants(sessionId: string) {
  const screen = capture(sessionId, 40)?.trim();
  if (!screen) return;
  const line = oneLine(
    await quick(
      `This is the end of a coding agent's terminal. The agent has stopped and is waiting for its user.\n\n<screen>\n${screen.slice(-4000)}\n</screen>\n\nIn one short line of at most 12 words, say what it wants from the user, starting with a verb, like "wants to run pnpm db:reset" or "asks whether to keep the old API". When it asks to run a command, name the command. Reply with that line only.`,
      { max: 30, timeoutMs: 4000 },
    ),
  );
  return line && line.length <= 120 ? line : undefined;
}

// A session left waiting gets one more, urgent nudge after a while; a phone push plugin sends that one loudly.
const waitingSince = new Map<string, { at: number; nudged: boolean }>();
export function escalate(sessions: Session[]) {
  const minutes = getSettings().alerts.escalateMinutes;
  for (const s of sessions) {
    if (s.status !== "waiting") {
      waitingSince.delete(s.id);
      continue;
    }
    // timed from when it started waiting; ones already overdue when cockpit starts don't all go off at once
    const w = waitingSince.get(s.id) ?? { at: s.updatedAt, nudged: Date.now() - s.updatedAt > minutes * 60_000 };
    waitingSince.set(s.id, w);
    if (!minutes || w.nudged || Date.now() - w.at < minutes * 60_000) continue;
    w.nudged = true;
    notify({ title: `Still waiting: ${s.title ?? s.name ?? shortPath(s.cwd)}`, body: `Claude has been waiting on you for ${minutes} minutes${wants.get(s.id) ? `: it ${wants.get(s.id)}` : s.waitingFor ? ` (${s.waitingFor})` : ""}.`, link: `/sessions/${s.id}`, urgent: true });
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
