// Relays on the canvas: a line between two terminals that passes each finished turn of one agent on to the other,
// with what it should do with it (review it, plan from it, carry on with it, or your own words). A turn finishes
// when its session goes from busy to idle. A message for an agent that's busy or waiting on you waits for it to be
// idle. Each hop counts, and at the line's limit it stops passing things on until you type into either terminal,
// so two agents never talk to each other for ever.
import type { CanvasRelay, Session } from "@cockpit/shared";
import { lastWords, sendText } from "./agents.ts";
import * as canvas from "./canvas.ts";
import { broadcast, tap } from "./hub.ts";
import { listTerms, onTermInput } from "./pty.ts";
import { onNode } from "./remote/sessions.ts";

const ASK: Record<Exclude<CanvasRelay["role"], "custom">, string> = {
  review: "Review this work. Say briefly what's wrong, risky or missing, and what to change. If it's good, say so.",
  plan: "Turn this into the next concrete steps, in order.",
  build: "Carry on with the work this describes.",
};

const MAX_TEXT = 8000;

export function relayMessage(from: string, text: string, relay: CanvasRelay, hop: number) {
  const ask = relay.role === "custom" ? relay.prompt! : ASK[relay.role];
  return `From ${from}, which just finished a turn:\n\n${text}\n\n${ask}\n\n(Passed on by cockpit's canvas, ${hop} of ${relay.limit}.)`;
}

// what each live session was last seen doing, from the sessions the app is told about
const seen = new Map<string, Session>();
// a message held for a session until it's idle, by the line it came along
const held = new Map<string, { to: string; text: string }>();

const sessionIn = (term: string) => [...seen.values()].find((s) => s.term === term && s.status !== "ended");
const titleOf = (s: Session) => s.title || s.name || listTerms().find((t) => t.id === s.term)?.title || "the other terminal";

async function lastText(s: Session) {
  if (!s.node) return (await lastWords(s.id, MAX_TEXT)).text;
  // a node's session: what it says it said last, which comes shortened
  return onNode(s.id, (n) => n.request<{ last?: string }>("session.ask", { id: s.id }), () => ({ last: undefined })).then((a) => a.last);
}

const send = (session: string, text: string) => onNode(session, (n) => n.request<boolean>("session.send", { id: session, text }), () => sendText(session, text));

// the canvas shows the count on the line
const changed = () => broadcast({ type: "canvas" });

async function finished(s: Session) {
  const relays = canvas.relaysFrom(s.term!);
  if (!relays.length) return;
  const text = await lastText(s).catch(() => undefined);
  if (!text?.trim()) return;
  for (const { edge, to } of relays) {
    const hops = edge.hops ?? 0;
    if (hops >= edge.relay!.limit) continue;
    const target = sessionIn(to);
    // no agent at the other end to read it
    if (!target) continue;
    const message = relayMessage(titleOf(s), text.trim(), edge.relay!, hops + 1);
    canvas.countHop(edge.id);
    if (target.status === "idle") await send(target.id, message).catch((e) => console.error("relay", e));
    else held.set(edge.id, { to: target.id, text: message });
  }
  changed();
}

function update(s: Session) {
  const was = seen.get(s.id)?.status;
  seen.set(s.id, s);
  if (s.status !== "idle") return;
  for (const [edge, m] of held)
    if (m.to === s.id) {
      held.delete(edge);
      void send(s.id, m.text).catch((e) => console.error("relay", e));
    }
  if (was === "busy" && s.term) void finished(s).catch((e) => console.error("relay", e));
}

export function startRelays() {
  tap((ev) => {
    if (ev.type === "sessions") for (const s of ev.sessions) update(s);
    if (ev.type === "session.update") update(ev.session);
  });
  // you stepped in: whatever it passed on so far, it may carry on again
  onTermInput((term) => {
    if (canvas.resetHops(term)) changed();
  });
}
