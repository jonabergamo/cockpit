// Relays on the canvas: a line between two terminals that passes each finished turn of one agent on to the other,
// with what it should do with it (review it, plan from it, carry on with it, or your own words). A turn finishes
// when its session goes from busy to idle. A message for an agent that's busy or waiting on you waits for it to be
// idle. Each hop counts, and at the line's limit it stops passing things on until you type into either terminal,
// so two agents never talk to each other for ever. An agent just opened and not asked anything yet has no session
// to send to: it's sitting at its prompt, so the message is typed into its terminal.
import type { CanvasRelay, Session } from "@cockpit/shared";
import { lastWords, sendText } from "./agents.ts";
import * as canvas from "./canvas.ts";
import { broadcast, tap } from "./hub.ts";
import { listTerms, onTermInput, typeInto } from "./pty.ts";
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
const held = new Map<string, { to: string; name: string; text: string }>();

const sessionIn = (term: string) => [...seen.values()].find((s) => s.term === term && s.status !== "ended");
// a terminal running an agent, by its command; a plain shell at the other end isn't typed into
const AGENT = /^(?:\S*\/)?(?:claude|codex|gemini)(?:\s|$)/;
const freshAgent = (term: string) => listTerms().some((t) => t.id === term && t.exited === undefined && t.state !== "exited" && AGENT.test(t.command));
// pasted the way a terminal pastes, so the agent takes it as one message, then sent
async function typeIn(term: string, text: string) {
  typeInto(term, `\x1b[200~${text}\x1b[201~`);
  await new Promise((r) => setTimeout(r, 300));
  typeInto(term, "\r");
}
const titleOf = (s: Session) => s.title || s.name || listTerms().find((t) => t.id === s.term)?.title || "the other terminal";
const nameOf = (term: string) => {
  const s = sessionIn(term);
  return s ? titleOf(s) : listTerms().find((t) => t.id === term)?.title || "the other terminal";
};
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function lastText(s: Session) {
  if (!s.node) return (await lastWords(s.id, MAX_TEXT)).text;
  // a node's session: what it says it said last, which comes shortened
  return onNode(s.id, (n) => n.request<{ last?: string }>("session.ask", { id: s.id }), () => ({ last: undefined })).then((a) => a.last);
}

const send = (session: string, text: string) => onNode(session, (n) => n.request<boolean>("session.send", { id: session, text }), () => sendText(session, text));

// what happened to a turn on its way along a line, shown on the line
function deliver(edge: string, name: string, go: () => Promise<boolean | void>) {
  return go().then(
    (ok) => canvas.setRelayStatus(edge, ok === false ? { state: "failed", text: `Couldn't reach ${name}'s terminal to type it in` } : { state: "sent", text: `Passed on to ${name}` }),
    (e) => {
      console.error("relay", e);
      canvas.setRelayStatus(edge, { state: "failed", text: `Couldn't pass it on to ${name}: ${why(e)}` });
    },
  );
}

// the canvas shows the count on the line
const changed = () => broadcast({ type: "canvas" });

async function finished(s: Session) {
  const relays = canvas.relaysFrom(s.term!).filter(({ edge }) => (edge.hops ?? 0) < edge.relay!.limit);
  if (!relays.length) return;
  const text = await lastText(s).catch(() => undefined);
  if (!text?.trim()) {
    for (const { edge } of relays) canvas.setRelayStatus(edge.id, { state: "failed", text: `Couldn't read what ${titleOf(s)} said in its last turn` });
    return changed();
  }
  for (const { edge, to } of relays) {
    const target = sessionIn(to);
    const name = nameOf(to);
    // no agent at the other end to read it
    if (!target && !freshAgent(to)) {
      canvas.setRelayStatus(edge.id, { state: "failed", text: `${name} isn't running an agent, so there was no one to pass ${titleOf(s)}'s turn to` });
      continue;
    }
    const message = relayMessage(titleOf(s), text.trim(), edge.relay!, (edge.hops ?? 0) + 1);
    canvas.countHop(edge.id);
    if (!target) await deliver(edge.id, name, () => typeIn(to, message));
    else if (target.status === "idle") await deliver(edge.id, name, () => send(target.id, message));
    else {
      held.set(edge.id, { to: target.id, name, text: message });
      canvas.setRelayStatus(edge.id, { state: "held", text: `Held for ${name}, which is ${target.status === "waiting" ? "waiting on you" : "busy"}: it goes once it's free` });
    }
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
      void deliver(edge, m.name, () => send(s.id, m.text)).then(changed);
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
