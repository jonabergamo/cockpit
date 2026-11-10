// Relays on the canvas: a line between two terminals that passes each finished turn of one agent on to the other,
// with what it should do with it (review it, plan from it, carry on with it, or your own words). A turn finishes
// when its session goes from busy to idle. A message for an agent that's busy or waiting on you waits for it to be
// idle. Each hop counts, and at the line's limit it stops passing things on until you type into either terminal,
// so two agents never talk to each other for ever. An agent just opened and not asked anything yet has no session
// to send to: it's sitting at its prompt, so the message is typed into its terminal. A review line also hands the
// reviewer what the turn changed in git, so it reviews the code and not only the agent's account of it.
import type { CanvasEdge, CanvasRelay, Run, Session } from "@cockpit/shared";
import { lastWords, sendText } from "./agents.ts";
import * as canvas from "./canvas.ts";
import { broadcast, tap } from "./hub.ts";
import { listTerms, onTermInput, onTermTurn, typeInto } from "./pty.ts";
import { requestApi } from "./remote/forward.ts";
import { onNode } from "./remote/sessions.ts";
import { listRuns, settledFail } from "./runs.ts";
import { markTree, turnChanges } from "./turndiff.ts";

const ASK: Record<Exclude<CanvasRelay["role"], "custom">, string> = {
  review: "Review this work. Say briefly what's wrong, risky or missing, and what to change. If it's good, say so.",
  plan: "Turn this into the next concrete steps, in order.",
  build: "Carry on with the work this describes.",
};

const MAX_TEXT = 8000;

// a review coming back to the one whose work it was
const ANSWER = "That's a review of your last turn. Fix what it's right about, and say briefly what you're leaving and why.";

// On a review line the reviewer is the end turns go to first (the target, when they go both ways); what comes back
// from it is a review to act on, not more work to review
export const reviewerEnd = (relay: CanvasRelay): "source" | "target" => (relay.from === "target" ? "source" : "target");

// changes: what the turn changed in git, under what it said, for a reviewer to read the code and not only the account
export function relayMessage(from: string, text: string, relay: CanvasRelay, hop: number, back = false, changes?: string) {
  const ask = relay.role === "custom" ? relay.prompt! : back ? ANSWER : ASK[relay.role];
  const diff = changes && !back && withDiff(relay) ? `\n\n${changes}` : "";
  return `From ${from}, which just ${back ? "reviewed your last turn" : "finished a turn"}:\n\n${text}${diff}\n\n${ask}\n\n(Passed on by cockpit's canvas, ${hop} of ${relay.limit}.)`;
}

// on by default for a review line
export const withDiff = (relay: CanvasRelay) => relay.role === "review" && relay.withDiff !== false;

// A turn that only says it heard ("Understood. Moving on.", "Thanks, looks good"): short, with no list, code or file
// in it, and nothing that turns it into a point ("Good catch, but the limit is still wrong"). Passing it on would only
// get one back, so a line stops there instead of spending a hop on it.
const ACK = /^(?:ok(?:ay)?|understood|got it|noted|thanks?(?: you)?|sounds good|great|good|perfect|alright|all right|will do|sure|agreed|makes sense|acknowledged|entendido|beleza|certo|combinado|valeu|obrigad[oa]|perfeito|blz)\b/i;
const POINT = /\b(?:but|however|though|although|still|except|unless|should|shouldn't|need|needs|must|missing|wrong|bug|broken|breaks|fails?|fix|issue|problem|instead|mas|por[eé]m|contudo|ainda|falta|faltou|errad[oa]|precisa|deveria|problema|quebr\w*)\b|\?/i;
export const onlyAcknowledges = (text: string) => {
  const t = text.trim();
  return t.length <= 240 && ACK.test(t) && !POINT.test(t) && !/```|`[^`]+`|^\s*(?:[-*•]|\d+[.)])\s/m.test(t) && !/\b[\w-]+\.[a-z]{1,5}(?::\d+)?\b/i.test(t);
};

// what each live session was last seen doing, from the sessions the app is told about
const seen = new Map<string, Session>();
// a message held for a session until it's idle, by the line it came along
const held = new Map<string, { to: string; name: string; text: string }>();

const sessionIn = (term: string) => [...seen.values()].find((s) => s.term === term && s.status !== "ended");
// a terminal running an agent, by its command; a plain shell at the other end isn't typed into. cockpit's chat
// with the local model (server/bin/chat.mjs) counts: it takes a pasted turn as one message
const CHAT = /\/server\/bin\/chat\.mjs(?:\s|$)/;
const AGENT = /^(?:\S*\/)?(?:claude|codex|gemini)(?:\s|$)|\/server\/bin\/chat\.mjs(?:\s|$)/;
const isChat = (term: string) => listTerms().some((t) => t.id === term && CHAT.test(t.command));
// A line both ways between an agent and cockpit's chat: the chat can only talk, so it's the reviewer whichever way
// the line was drawn
function reviewerOf(edge: CanvasEdge): "source" | "target" {
  const ends = edge.relay!.from === "both" ? canvas.termEnds(edge.id) : undefined;
  if (ends && isChat(ends.source) !== isChat(ends.target)) return isChat(ends.source) ? "source" : "target";
  return reviewerEnd(edge.relay!);
}
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

// The folder each busy session's turn started from, for the review lines that hand over the turn's diff. Marked on
// the machine the session runs on, as soon as it's seen busy.
const marks = new Map<string, Promise<string | undefined>>();
const mark = (s: Session) => onNode(s.id, (n) => n.request<string | null>("git.mark", { cwd: s.cwd }), () => markTree(s.cwd)).then((t) => t ?? undefined, () => undefined);
async function changesOf(s: Session, from: Promise<string | undefined> | undefined) {
  if (!from) return "(cockpit didn't see this turn start, so it has no diff of what it changed.)";
  const base = await from;
  if (!base) return undefined;
  return onNode(s.id, (n) => n.request<string | null>("git.turn", { cwd: s.cwd, from: base }), () => turnChanges(s.cwd, base)).then(
    (t) => t ?? undefined,
    (e) => `(cockpit couldn't diff what the turn changed: ${why(e)})`,
  );
}
const wantsDiff = (term: string) => open(term).some(({ edge, toEnd }) => withDiff(edge.relay!) && toEnd === reviewerOf(edge));

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

// A line set to pass on only passing work holds a turn back while any of its checks is failing: the runs the session
// or its terminal did in the last day, on whichever machine it runs, that failed and weren't fixed since.
const RECENT_MS = 24 * 3600_000;
export async function failingChecks(s: Pick<Session, "id" | "term" | "node">): Promise<Run[]> {
  const f = { session: s.id, ...(s.term ? { terminal: s.term } : {}), status: "fail" as const, since: Date.now() - RECENT_MS, limit: 50 };
  const runs =
    s.node && s.node !== "local"
      ? await requestApi(s.node, { method: "GET", path: `/runs?${new URLSearchParams(Object.entries(f).map(([k, v]): [string, string] => [k, String(v)]))}`, headers: {} }).then((r) => (r.status === 200 ? (JSON.parse(r.body) as Run[]) : []))
      : listRuns(f);
  return runs.filter((r) => !settledFail(r));
}

// the canvas shows the count on the line
const changed = () => broadcast({ type: "canvas" });

const open = (term: string) => canvas.relaysFrom(term).filter(({ edge }) => (edge.hops ?? 0) < edge.relay!.limit);

async function finished(s: Session, from: Promise<string | undefined> | undefined) {
  const relays = open(s.term!);
  if (!relays.length) return;
  // only worked out when it goes to a reviewer that wants it
  const changes = relays.some(({ edge, toEnd }) => withDiff(edge.relay!) && toEnd === reviewerOf(edge)) ? await changesOf(s, from) : undefined;
  // the lines that only pass on passing work hold this turn back while its checks fail
  const gated = relays.some(({ edge }) => edge.relay!.when === "passing" || edge.relay!.when === "failing");
  const failing = gated ? await failingChecks(s).catch(() => [] as Run[]) : [];
  const text = await lastText(s).catch(() => undefined);
  if (!text?.trim()) {
    for (const { edge } of relays) canvas.setRelayStatus(edge.id, { state: "failed", text: `Couldn't read what ${titleOf(s)} said in its last turn` });
    return changed();
  }
  await passOn(relays, titleOf(s), text, failing, changes);
}

// an answer finished in cockpit's chat, which has no session: it has no checks of its own to hold it back
const chatSaid = new Map<string, string>();
async function chatFinished(term: string, text: string) {
  chatSaid.set(term, text);
  const relays = open(term);
  if (relays.length) await passOn(relays, nameOf(term), text, []);
}

async function passOn(relays: ReturnType<typeof open>, from: string, text: string, failing: Run[], changes?: string) {
  if (onlyAcknowledges(text)) {
    for (const { edge } of relays) canvas.setRelayStatus(edge.id, { state: "held", text: `Stopped: ${from} only acknowledged, so there was nothing to pass on` });
    return;
  }
  for (const { edge, to, toEnd } of relays) {
    const target = sessionIn(to);
    const name = nameOf(to);
    if (edge.relay!.when === "failing" && !failing.length) {
      canvas.setRelayStatus(edge.id, { state: "held", text: `Held back: nothing is failing in ${from}, so there's nothing to hand ${name}` });
      continue;
    }
    if (edge.relay!.when === "passing" && failing.length) {
      const what = [...new Set(failing.map((r) => r.name))].slice(0, 2).join(" and ");
      canvas.setRelayStatus(edge.id, { state: "held", text: `Held back: ${what}${failing.length > 2 ? " and more" : ""} failing in ${from}. The next turn after they pass goes to ${name}` });
      continue;
    }
    // no agent at the other end to read it
    if (!target && !freshAgent(to)) {
      canvas.setRelayStatus(edge.id, { state: "failed", text: `${name} isn't running an agent, so there was no one to pass ${from}'s turn to` });
      continue;
    }
    const back = edge.relay!.role === "review" && toEnd !== reviewerOf(edge);
    const message = relayMessage(from, text.trim(), edge.relay!, (edge.hops ?? 0) + 1, back, changes);
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
  if (s.status === "busy" && s.term && s.cwd && !marks.has(s.id) && wantsDiff(s.term)) marks.set(s.id, mark(s));
  if (s.status === "ended") marks.delete(s.id);
  if (s.status !== "idle") return;
  const from = marks.get(s.id);
  marks.delete(s.id);
  for (const [edge, m] of held)
    if (m.to === s.id) {
      held.delete(edge);
      void deliver(edge, m.name, () => send(s.id, m.text)).then(changed);
    }
  if (was === "busy" && s.term) void finished(s, from).catch((e) => console.error("relay", e));
}

// A last answer handed along a line, once, when you say: what the agent at one end said last goes to the agent at the
// other, with what you'd like done with it. It's delivered the way a relayed turn is (held while the other is busy).
export const handOffMessage = (from: string, text: string, ask?: string) =>
  `From ${from}, its last answer, handed to you:\n\n${text}\n\n${ask?.trim() || "Take it into account in what you do next."}\n\n(Passed on by cockpit's canvas.)`;

export async function handOff(edge: string, from: "source" | "target", ask?: string) {
  const ends = canvas.termEnds(edge);
  if (!ends) throw new Error("Only a line between two terminals can hand an answer over");
  const fromTerm = ends[from];
  const to = ends[from === "source" ? "target" : "source"];
  const s = sessionIn(fromTerm);
  const said = s || !isChat(fromTerm) ? undefined : chatSaid.get(fromTerm);
  if (!s && !said) throw new Error(`${nameOf(fromTerm)} has no agent in it that has answered yet, so there's no answer to hand over`);
  const fromName = s ? titleOf(s) : nameOf(fromTerm);
  const text = (s ? await lastText(s).catch(() => undefined) : said)?.trim();
  if (!text) throw new Error(`Couldn't read what ${fromName} said last`);
  const target = sessionIn(to);
  const name = nameOf(to);
  if (!target && !freshAgent(to)) throw new Error(`${name} isn't running an agent, so there's no one to hand it to`);
  const message = handOffMessage(fromName, text, ask?.slice(0, 2000));
  if (!target) await deliver(edge, name, () => typeIn(to, message));
  else if (target.status === "idle") await deliver(edge, name, () => send(target.id, message));
  else {
    held.set(edge, { to: target.id, name, text: message });
    canvas.setRelayStatus(edge, { state: "held", text: `Held for ${name}, which is ${target.status === "waiting" ? "waiting on you" : "busy"}: it goes once it's free` });
  }
  changed();
}

export function startRelays() {
  tap((ev) => {
    if (ev.type === "sessions") for (const s of ev.sessions) update(s);
    if (ev.type === "session.update") update(ev.session);
  });
  onTermTurn((term, text) => void chatFinished(term, text).catch((e) => console.error("relay", e)));
  // you stepped in: whatever it passed on so far, it may carry on again
  onTermInput((term) => {
    if (canvas.resetHops(term)) changed();
  });
}
