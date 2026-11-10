// A panel of reviewers: review lines leaving the same author that review its turns together. Each member gets the
// turn as a review line hands it; their reviews are gathered until every one has answered (or gone), or the wait is
// up, and go back to the author as one: merged by the local model when there is one (what they agree on, what only
// one raised, where they disagree), else each under its reviewer's name. Turns that only acknowledge add nothing, and
// when that's all there is nothing goes back.
import type { PanelPart } from "@cockpit/shared";
import { onlyAcknowledges } from "./ack.ts";
import { quick } from "./quick.ts";

export interface Member {
  edge: string;
  // the reviewer's card, and what it's called
  card: string;
  term: string;
  name: string;
}

export interface Gathered {
  members: Member[];
  // by edge, what each said; missing ones didn't answer
  replies: Map<string, string>;
  timedOut: boolean;
}

// Waits for the members' reviews of one turn. done is called once: when the last one is in or gone, or at the wait.
export class Gather {
  readonly replies = new Map<string, string>();
  private gone = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private over = false;
  constructor(
    readonly members: Member[],
    waitMs: number,
    private done: (g: Gathered) => void,
  ) {
    this.timer = setTimeout(() => this.finish(true), waitMs);
    this.timer.unref?.();
  }
  waits = (edge: string) => !this.over && this.members.some((m) => m.edge === edge) && !this.replies.has(edge) && !this.gone.has(edge);
  // a member's review: true when it was waited on
  add(edge: string, text: string) {
    if (!this.waits(edge)) return false;
    this.replies.set(edge, text);
    this.check();
    return true;
  }
  // a member that won't answer: its terminal closed, or the turn never reached it
  drop(edge: string) {
    if (!this.waits(edge)) return;
    this.gone.add(edge);
    this.check();
  }
  // whatever is in hand, now
  finish(timedOut = false) {
    if (this.over) return;
    this.over = true;
    clearTimeout(this.timer);
    this.done({ members: this.members, replies: this.replies, timedOut });
  }
  get open() {
    return !this.over;
  }
  private check() {
    if (this.members.every((m) => this.replies.has(m.edge) || this.gone.has(m.edge))) this.finish();
  }
}

export const partsOf = (g: Gathered): PanelPart[] =>
  g.members.map((m) => {
    const text = g.replies.get(m.edge)?.trim();
    if (!text) return { from: m.card, name: m.name, outcome: "silent" };
    return { from: m.card, name: m.name, outcome: onlyAcknowledges(text) ? "acknowledged" : "answered", text };
  });

const MAX_EACH = 6000;

export const mergePrompt = (parts: PanelPart[]) =>
  `${parts.length} reviewers reviewed the same piece of work. Merge their reviews into one review for its author to act on, in up to three parts, leaving out a part with nothing in it:

## Agreed
The points more than one of them made.

## Raised by one
Each point only one of them made, ending with who in brackets, like (${parts[0]?.name ?? "Reviewer"}).

## Disagreements
Where they disagree, each side with who said it.

Keep file names, line numbers and code exactly as they wrote them. Add nothing of your own, and say nothing before or after the review.

${parts.map((p) => `### ${p.name}\n\n${p.text!.slice(0, MAX_EACH)}`).join("\n\n")}`;

// each under its reviewer's name, when there's no model to merge them or only one has anything to say
export const underNames = (parts: PanelPart[]) => parts.map((p) => `### ${p.name}\n\n${p.text!.trim()}`).join("\n\n");

// One review from the panel's, or undefined when none of them said more than that they'd heard. ask is the local
// model; without it, or when it fails, each review goes under its reviewer's name.
export async function mergeReviews(parts: PanelPart[], wait: string, ask: (prompt: string) => Promise<string | undefined> = (p) => quick(p, { max: 1500, timeoutMs: 120_000 })) {
  const said = parts.filter((p) => p.outcome === "answered");
  if (!said.length) return;
  const merged = said.length > 1 ? (await ask(mergePrompt(said)).catch(() => undefined))?.trim() : undefined;
  const heard = parts.filter((p) => p.outcome === "acknowledged").map((p) => p.name);
  const silent = parts.filter((p) => p.outcome === "silent").map((p) => p.name);
  const notes = [
    ...(heard.length ? [`${and(heard)} had nothing to add.`] : []),
    ...(silent.length ? [`${and(silent)} didn't answer${wait ? ` within ${wait}` : ""}.`] : []),
  ];
  return { text: [merged || underNames(said), ...(notes.length ? [notes.join(" ")] : [])].join("\n\n"), merged: !!merged };
}

const and = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]);
