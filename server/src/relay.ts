// Relays on the canvas: a line between two terminals that passes each finished turn of one agent on to the other,
// with what it should do with it (review it, plan from it, carry on with it, or your own words). A turn finishes
// when its session goes from busy to idle. A message for an agent that's busy or waiting on you waits for it to be
// idle. Each hop counts, and at the line's limit it stops passing things on until you type into either terminal,
// so two agents never talk to each other for ever. An agent just opened and not asked anything yet has no session
// to send to: it's sitting at its prompt, so the message is typed into its terminal. A review line also hands the
// reviewer what the turn changed in git, so it reviews the code and not only the agent's account of it.
import { randomUUID } from "node:crypto";
import type { CanvasEdge, CanvasRelay, RelayLogEntry, Run, Session } from "@cockpit/shared";
import { lastWords, sendText } from "./agents.ts";
import * as canvas from "./canvas.ts";
import { broadcast, tap } from "./hub.ts";
import { listTerms, onTermInput, onTermTurn, typeInto } from "./pty.ts";
import { requestApi } from "./remote/forward.ts";
import { onNode } from "./remote/sessions.ts";
import { listRuns, settledFail } from "./runs.ts";
import { getSettings } from "./settings.ts";
import { markTree, turnChanges } from "./turndiff.ts";
import { onlyAcknowledges } from "./ack.ts";
import { Gather, mergeReviews, partsOf, type Gathered, type Member } from "./panel.ts";

export { onlyAcknowledges };

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

// what each live session was last seen doing, from the sessions the app is told about
const seen = new Map<string, Session>();
// a message held for a session until it's idle, by the line it came along (or the history entry sent again, or the
// panel), and its entry in the line's history: a panel's goes back along each of its lines
type Held = { edge: string | string[]; to: string; name: string; text: string; log: number | number[] };
const held = new Map<string, Held>();

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

// what happened to a turn on its way along a line, shown on the line and kept in its history. True when it got there.
function deliver(edge: string | string[], name: string, go: () => Promise<boolean | void>, log?: number | number[]) {
  const edges = [edge].flat();
  const logs = log === undefined ? [] : [log].flat();
  const failed = (text: string) => {
    for (const e of edges) canvas.setRelayStatus(e, { state: "failed", text });
    for (const l of logs) canvas.setLogOutcome(l, "failed", text);
    return false;
  };
  return go().then(
    (ok) => {
      if (ok === false) return failed(`Couldn't reach ${name}'s terminal to type it in`);
      for (const e of edges) canvas.setRelayStatus(e, { state: "sent", text: `Passed on to ${name}` });
      for (const l of logs) canvas.setLogOutcome(l, "delivered");
      return true;
    },
    (e) => {
      console.error("relay", e);
      return failed(`Couldn't pass it on to ${name}: ${why(e)}`);
    },
  );
}

// sent now when the agent at the other end is free (or typed in when it's only just opened), else held until it is:
// true when it got there, undefined while it's held
async function sendOrHold(key: string, edge: string | string[], to: string, message: string, log: number | number[]): Promise<boolean | undefined> {
  const target = sessionIn(to);
  const name = nameOf(to);
  if (!target) return deliver(edge, name, () => typeIn(to, message), log);
  if (target.status === "idle") return deliver(edge, name, () => send(target.id, message), log);
  held.set(key, { edge, to: target.id, name, text: message, log });
  const text = `Held for ${name}, which is ${target.status === "waiting" ? "waiting on you" : "busy"}: it goes once it's free`;
  for (const e of [edge].flat()) canvas.setRelayStatus(e, { state: "held", text });
  for (const l of [log].flat()) canvas.setLogOutcome(l, "held", text);
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
// the lines out of a terminal that stopped at their limit and haven't yet said so in their history: the first turn
// past the limit is kept there, not every one after it
const stopped = (term: string) => canvas.relaysFrom(term).filter(({ edge }) => (edge.hops ?? 0) >= edge.relay!.limit && canvas.lastLog(edge.id)?.outcome !== "limit");
type Relays = ReturnType<typeof open>;
// the cards a turn goes between on a line
const cardsOf = ({ edge, toEnd }: Relays[number]) => ({ from: toEnd === "target" ? edge.source : edge.target, to: toEnd === "target" ? edge.target : edge.source });
const isBack = ({ edge, toEnd }: Relays[number]) => edge.relay!.role === "review" && toEnd !== reviewerOf(edge);

function logStopped(relays: Relays, from: string, text: string) {
  for (const r of relays) {
    const hops = r.edge.hops ?? 0;
    const message = relayMessage(from, text.trim(), r.edge.relay!, hops, isBack(r));
    canvas.logRelay({ edge: r.edge.id, hop: hops, limit: r.edge.relay!.limit, ...cardsOf(r), kind: "skipped-limit", text: message, outcome: "limit", note: `Stopped at ${r.edge.relay!.limit} hops: type into either terminal to carry on` });
  }
}

async function finished(s: Session, from: Promise<string | undefined> | undefined) {
  const relays = open(s.term!);
  const limited = stopped(s.term!);
  if (!relays.length && !limited.length) return;
  // only worked out when it goes to a reviewer that wants it
  const changes = relays.some(({ edge, toEnd }) => withDiff(edge.relay!) && toEnd === reviewerOf(edge)) ? await changesOf(s, from) : undefined;
  // the lines that only pass on passing work hold this turn back while its checks fail
  const gated = relays.some(({ edge }) => edge.relay!.when === "passing" || edge.relay!.when === "failing");
  const failing = gated ? await failingChecks(s).catch(() => [] as Run[]) : [];
  const text = await lastText(s).catch(() => undefined);
  if (text?.trim()) logStopped(limited, titleOf(s), text);
  if (!relays.length) return limited.length ? changed() : undefined;
  if (!text?.trim()) {
    for (const r of relays) {
      canvas.setRelayStatus(r.edge.id, { state: "failed", text: `Couldn't read what ${titleOf(s)} said in its last turn` });
      // a panel waiting on this review won't get it
      if (isBack(r) && r.edge.relay!.panel) gathers.get(panelKey(cardsOf(r).to, r.edge.relay!.panel))?.drop(r.edge.id);
    }
    return changed();
  }
  await passOn(relays, titleOf(s), text, failing, changes);
}

// an answer finished in cockpit's chat, which has no session: it has no checks of its own to hold it back
const chatSaid = new Map<string, string>();
async function chatFinished(term: string, text: string) {
  chatSaid.set(term, text);
  logStopped(stopped(term), nameOf(term), text);
  const relays = open(term);
  if (relays.length) await passOn(relays, nameOf(term), text, []);
}

async function passOn(relays: Relays, from: string, text: string, failing: Run[], changes?: string) {
  const ack = onlyAcknowledges(text);
  // the review lines out of here that review together, by panel: the turn goes to each, and those it reached (with a
  // hop left for their review to come back) are waited on
  const panels = new Map<string, Relays>();
  for (const r of relays) if (!isBack(r) && r.edge.relay!.role === "review" && r.edge.relay!.panel) panels.set(r.edge.relay!.panel, [...(panels.get(r.edge.relay!.panel) ?? []), r]);
  for (const [p, rs] of panels) if (rs.length < 2) panels.delete(p);
  const waiting = new Map<string, Member[]>();
  for (const r of relays) {
    const { edge, to } = r;
    const name = nameOf(to);
    const hop = (edge.hops ?? 0) + 1;
    const back = isBack(r);
    const message = relayMessage(from, text.trim(), edge.relay!, hop, back, changes);
    const entry = { edge: edge.id, limit: edge.relay!.limit, ...cardsOf(r), text: message };
    // a review for a panel that's gathering them: kept until the rest are in, and goes back with theirs as one
    const gather = back && edge.relay!.panel ? gathers.get(panelKey(entry.to, edge.relay!.panel)) : undefined;
    if (gather?.waits(edge.id)) {
      panelLogs.set(edge.id, canvas.logRelay({ ...entry, text: text.trim(), hop: hop - 1, kind: "back", outcome: "held", note: "Kept for the panel: it goes back with the other reviews, as one" }));
      canvas.setRelayStatus(edge.id, { state: "held", text: "Kept for the panel until the other reviews are in" });
      gather.add(edge.id, text);
      continue;
    }
    // not passed on: kept in the line's history as it would have gone, and said on the line
    const skip = (kind: RelayLogEntry["kind"], outcome: RelayLogEntry["outcome"], text: string, state: "held" | "failed" = "held") => {
      canvas.logRelay({ ...entry, hop: hop - 1, kind, outcome, note: text });
      canvas.setRelayStatus(edge.id, { state, text });
    };
    if (ack) {
      skip("skipped-ack", "stopped-ack", `Stopped: ${from} only acknowledged, so there was nothing to pass on`);
      continue;
    }
    if (edge.relay!.when === "failing" && !failing.length) {
      skip("held", "held", `Held back: nothing is failing in ${from}, so there's nothing to hand ${name}`);
      continue;
    }
    if (edge.relay!.when === "passing" && failing.length) {
      const what = [...new Set(failing.map((r) => r.name))].slice(0, 2).join(" and ");
      skip("held", "held", `Held back: ${what}${failing.length > 2 ? " and more" : ""} failing in ${from}. The next turn after they pass goes to ${name}`);
      continue;
    }
    // no agent at the other end to read it
    if (!sessionIn(to) && !freshAgent(to)) {
      skip(back ? "back" : "forward", "failed", `${name} isn't running an agent, so there was no one to pass ${from}'s turn to`, "failed");
      continue;
    }
    canvas.countHop(edge.id);
    const log = canvas.logRelay({ ...entry, hop, kind: back ? "back" : "forward", outcome: "pending" });
    const went = await sendOrHold(edge.id, edge.id, to, message, log);
    const p = edge.relay!.panel;
    if (p && panels.has(p) && went !== false && hop < edge.relay!.limit) waiting.set(p, [...(waiting.get(p) ?? []), { edge: edge.id, card: entry.to, term: to, name }]);
  }
  for (const [p, members] of waiting) if (members.length > 1) gatherFor(panelKey(cardsOf(panels.get(p)![0]).from, p), members);
  changed();
}

// The panels gathering reviews, by the author's card and panel, and each review kept for one by its line
const gathers = new Map<string, Gather>();
const panelLogs = new Map<string, number>();
const panelKey = (author: string, panel: string) => `${author}|${panel}`;
// how long a panel's reviews are waited for; a test sets its own
export const panelWait = { ms: () => getSettings().panels.waitMinutes * 60_000 };
const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

function gatherFor(key: string, members: Member[]) {
  // a turn of the author's before the last one's reviews were all in: those in hand go now
  gathers.get(key)?.finish();
  const wait = panelWait.ms();
  const g = new Gather(members, wait, (done) => {
    if (gathers.get(key) === g) gathers.delete(key);
    void panelDone(key.slice(0, key.indexOf("|")), done, minutes(wait))
      .catch((e) => console.error("relay panel", e))
      .then(changed);
  });
  gathers.set(key, g);
}

const panelMessage = (names: string[], text: string, hop: number, limit: number) =>
  `From the review panel (${names.join(", ")}), which just reviewed your last turn:\n\n${text}\n\n${ANSWER}\n\n(Passed on by cockpit's canvas, ${hop} of ${limit}.)`;

// The panel's reviews of a turn, in: merged into one, sent back once along its lines (a hop on each), and kept in
// each one's history with every review as it came
async function panelDone(author: string, g: Gathered, wait: string) {
  const parts = partsOf(g);
  for (const m of g.members) {
    const log = panelLogs.get(m.edge);
    panelLogs.delete(m.edge);
    if (log !== undefined) canvas.setLogOutcome(log, "delivered", "Gathered into the panel's review");
  }
  const lines = g.members.flatMap((m) => {
    const e = canvas.edgeById(m.edge);
    return e?.relay ? [{ m, hops: e.hops ?? 0, relay: e.relay }] : [];
  });
  const authorTerm = canvas.termOfCard(author)?.term;
  if (!lines.length || !authorTerm) return;
  const merged = await mergeReviews(parts, g.timedOut ? wait : "");
  const entry = (l: (typeof lines)[number], hop: number, text: string, outcome: RelayLogEntry["outcome"], note?: string) =>
    canvas.logRelay({ edge: l.m.edge, hop, limit: l.relay.limit, from: l.m.card, to: author, kind: "panel", text, outcome, parts, ...(note ? { note } : {}) });
  const stop = (text: string, state: "held" | "failed", outcome: RelayLogEntry["outcome"]) => {
    for (const l of lines) {
      entry(l, l.hops, "", outcome, text);
      canvas.setRelayStatus(l.m.edge, { state, text });
    }
  };
  if (!merged) {
    if (parts.every((p) => p.outcome === "silent")) return stop(`None of the panel answered${g.timedOut ? ` within ${wait}` : ""}, so nothing went back`, "failed", "failed");
    return stop("Stopped: the panel only acknowledged, so there was nothing to pass back", "held", "stopped-ack");
  }
  if (!sessionIn(authorTerm) && !freshAgent(authorTerm)) return stop(`${nameOf(authorTerm)} isn't running an agent, so there was no one to hand the panel's review to`, "failed", "failed");
  const names = g.members.map((m) => m.name);
  const note = merged.merged ? undefined : "Put under each reviewer's name: no local model merged them";
  const logs = lines.map((l) => {
    canvas.countHop(l.m.edge);
    return entry(l, l.hops + 1, panelMessage(names, merged.text, l.hops + 1, l.relay.limit), "pending", note);
  });
  await sendOrHold(`panel:${author}|${lines[0].relay.panel}`, lines.map((l) => l.m.edge), authorTerm, panelMessage(names, merged.text, lines[0].hops + 1, lines[0].relay.limit), logs);
}

// the review lines out of an author's terminal, to their reviewers
const reviewsFrom = (term: string) => canvas.relaysFrom(term).filter((r) => r.edge.relay!.role === "review" && r.toEnd === reviewerOf(r.edge));
const authorOf = (edge: string) => {
  const e = canvas.edgeById(edge);
  if (e?.relay?.role !== "review") throw new Error("Only a review line can review together with another");
  const term = canvas.termOfCard(reviewerOf(e) === "target" ? e.source : e.target)?.term;
  if (!term) throw new Error("The line's author isn't a terminal");
  return { e, term };
};
// a panel left with one line in it is a plain review line again
function tidyPanel(term: string, panel: string) {
  const left = reviewsFrom(term).filter((r) => r.edge.relay!.panel === panel);
  if (left.length === 1) canvas.setPanel(left[0].edge.id, undefined);
}

// A review line joins another from the same author to review its turns together, or leaves its panel (null)
export function joinPanel(edge: string, other: string | null) {
  const { e, term } = authorOf(edge);
  const was = e.relay!.panel;
  if (!other) {
    canvas.setPanel(edge, undefined);
    if (was) tidyPanel(term, was);
    return;
  }
  if (other === edge) throw new Error("Pick another review line");
  const o = authorOf(other);
  if (o.term !== term) throw new Error("Both lines have to review the same terminal's turns");
  const panel = o.e.relay!.panel ?? was ?? randomUUID().slice(0, 8);
  canvas.setPanel(edge, panel);
  canvas.setPanel(other, panel);
  if (was && was !== panel) tidyPanel(term, was);
}

function update(s: Session) {
  const was = seen.get(s.id)?.status;
  seen.set(s.id, s);
  if (s.status === "busy" && s.term && s.cwd && !marks.has(s.id) && wantsDiff(s.term)) marks.set(s.id, mark(s));
  if (s.status === "ended") {
    marks.delete(s.id);
    // a reviewer that's gone won't answer its panel
    if (s.term) for (const g of gathers.values()) for (const m of g.members) if (m.term === s.term) g.drop(m.edge);
  }
  if (s.status !== "idle") return;
  const from = marks.get(s.id);
  marks.delete(s.id);
  for (const [key, m] of held)
    if (m.to === s.id) {
      held.delete(key);
      void deliver(m.edge, m.name, () => send(s.id, m.text), m.log).then(changed);
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
  if (!sessionIn(to) && !freshAgent(to)) throw new Error(`${nameOf(to)} isn't running an agent, so there's no one to hand it to`);
  const message = handOffMessage(fromName, text, ask?.slice(0, 2000));
  const cards = canvas.edgeCards(edge)!;
  const log = canvas.logRelay({ edge, hop: 0, from: cards[from], to: cards[from === "source" ? "target" : "source"], kind: "handoff", text: message, outcome: "pending" });
  await sendOrHold(edge, edge, to, message, log);
  changed();
}

// One message from a line's history sent again, as it was, to the card it went to or another terminal on the same
// workspace. It's kept in the history as a replay and doesn't count against the line's hop limit.
export async function replay(id: number, toCard?: string) {
  const was = canvas.logEntry(id);
  if (!was) throw new Error("That message isn't in the line's history any more");
  if (!was.text.trim()) throw new Error("Nothing went with that one, so there's nothing to send again");
  const line = canvas.edgeCards(was.edge);
  if (!line) throw new Error("That line has gone");
  const card = toCard || was.to;
  const end = canvas.termOfCard(card);
  if (!end || end.canvas !== line.canvas) throw new Error("Send it to a terminal on the same workspace");
  if (!sessionIn(end.term) && !freshAgent(end.term)) throw new Error(`${nameOf(end.term)} isn't running an agent, so there's no one to send it to`);
  const kind = was.kind === "back" || was.kind === "handoff" || was.kind === "panel" ? was.kind : "forward";
  const log = canvas.logRelay({ edge: was.edge, hop: line.hops, ...(was.limit ? { limit: was.limit } : {}), from: was.from, to: card, kind, text: was.text, outcome: "pending", replay: was.id });
  await sendOrHold(`replay:${log}`, was.edge, end.term, was.text, log);
  changed();
  return canvas.logEntry(log)!;
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
