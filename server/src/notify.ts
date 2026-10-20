import type { Session } from "@cockpit/shared";
import { broadcast } from "./hub.ts";
import { emit } from "./events.ts";
import { listTerms } from "./pty.ts";

const shortPath = (p: string) => (process.env.HOME ? p.replace(process.env.HOME, "~") : p);

let seq = 0;
export function notify(n: { title: string; body: string; link: string }) {
  broadcast({ type: "notify", id: ++seq, ...n });
  emit("notify", n);
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
    emit("session.ended", { id });
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
