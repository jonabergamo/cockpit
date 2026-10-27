// The ticket pipeline on the Work screen: each of your tickets on the road its kind takes, from worktree to merged
// (and on to wherever a plugin says it got deployed), with the step that moves it on. While there's work going on,
// where a ticket stands is the Board's own placement, so the two views agree; before there's any work, and once
// the PR is merged, the road goes on without it. Plugins add roads of their own (k.ticketRoads), for tickets they
// know better: E2E tests, discoveries and the like.
import type { BoardCard, Pipeline, PipelineRow, PullRequest, RoadAction, RoadBadge, RoadEntry, RoadTicket, Ticket, TicketRoads, Worktree } from "@cockpit/shared";
import { names } from "./board.ts";

export interface PluginRoads {
  plugin: string;
  name: string;
  roads: TicketRoads;
  error?: string;
}

export interface PipelineInput {
  tickets: Ticket[];
  prs: { mine: PullRequest[]; review?: PullRequest[] };
  worktrees: Pick<Worktree, "path" | "ticket" | "main" | "node" | "branch">[];
  cards: BoardCard[];
  plugins: PluginRoads[];
  agent: string;
  // a regex over the summary for tickets with no code, and the branches a PR into ships
  noCode: string;
  // tickets the local model sorted as no code, on top of the pattern
  noCodeKeys?: Set<string>;
  mainBranches: string[];
}

type Place = Omit<RoadEntry, "key" | "kind" | "steps">;

const isDone = (t: Ticket) => t.statusCategory === "done" || /^done$/i.test(t.status);
const onHold = (t: Ticket) => /blocked|on hold/i.test(t.status);

// a PR's own state, shared by every kind of ticket that ends in one
export function prState(pr?: PullRequest) {
  const rv = pr?.reviewers ?? [];
  return {
    merged: pr?.state === "MERGED",
    open: pr?.state === "OPEN",
    waiting: names(rv.filter((r) => r.state === "REQUESTED" || r.state === "PENDING").map((r) => r.name)),
    changes: names(rv.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.name)),
    approved: pr?.reviewDecision === "APPROVED" || (rv.length > 0 && rv.every((r) => r.state === "APPROVED")),
  };
}

// The roads core knows. stages are the stops after Merged a plugin knows about (Staging, Production); without
// any, a ticket's road ends when it's Done in the tracker.
export const codeSteps = (agent: string, stages: string[]) => ["Worktree", agent, "PR", "Review", "Merged", ...(stages.length ? stages : ["Done"])];
export const featureSteps = (agent: string, stages: string[]) => ["Worktree", agent, "PR", "Review", "Into feature", "Feature PR", ...(stages.length ? stages : ["Done"])];

const act = (id: string, label: string, primary = false): RoadAction => ({ id, label, primary });

// How far after Merged a ticket got: the stage it reached, else Done in the tracker when there are no stages
function shipped(t: Ticket, stages: string[], where?: string) {
  if (!stages.length) return isDone(t) ? 1 : 0;
  const i = where ? stages.findIndex((s) => s.toLowerCase() === where.toLowerCase()) : -1;
  return i + 1;
}

// How far along the code road a ticket is, from its worktree, session and PR
export function stepOf(t: Ticket, wt: string | undefined, pr: PullRequest | undefined, stages: string[], where?: string) {
  const p = prState(pr);
  const done = [!!wt || !!pr, !!t.lastSession || !!pr, !!pr, p.approved || p.merged, p.merged];
  const at = done.indexOf(false);
  return at === -1 ? done.length + shipped(t, stages, where) : at;
}

// Where a code ticket is and what moves it on
export function placeCode(t: Ticket, wt: string | undefined, pr: PullRequest | undefined, card: BoardCard | undefined, agent: string, stages: string[], where?: string): Place {
  const at = stepOf(t, wt, pr, stages, where);
  const end = 5 + Math.max(1, stages.length);
  const out = (next: string, rest: Partial<Place> = {}): Place => ({ at, bad: false, needsYou: false, shipping: false, actions: [], next, ...rest });
  const one = (id: string, label: string, needsYou: boolean) => ({ needsYou, actions: [act(id, label, needsYou)] });
  const merged = pr?.state === "MERGED";
  // past development in the tracker with no PR found: its PR doesn't name the ticket, or there was no code
  if (!pr && (isDone(t) || /^(qa|uat|pending deployment)$/i.test(t.status))) return out(`${t.status} in the tracker, no PR names it`, { at: end, shipping: true });
  if (merged) {
    if (at >= end) return out(stages.length ? `In ${stages.at(-1)!.toLowerCase()}` : "Done", { shipping: true });
    if (at > 5) return out(`${stages[at - 6]}, on its way to ${stages[at - 5].toLowerCase()}`, { shipping: true });
    return out(stages.length && where === undefined && isDone(t) ? "Done, its release isn't tracked" : `Merged, waiting for ${stages.length ? stages[0].toLowerCase() : "its ticket to reach Done"}`, { shipping: true });
  }
  if (pr?.state === "CLOSED") return out("PR closed without merging", { needsYou: true, actions: [act("pr", "Open PR", true)] });
  if (!pr && onHold(t)) return out("Nothing to do until it moves");
  if (!card) {
    if (!wt && !pr) return t.epic ? out(`Goes in the ${t.epic} epic's worktree`, one("epic", "Tickets", false)) : out("Not started", one("start", "Start", true));
    if (!pr && !t.lastSession) return out(`Worktree ready, no ${agent} yet`, one("agent", `Start ${agent}`, true));
    if (!pr) return t.lastSession?.status === "busy" ? out(`${agent} is working on it`, { busy: true }) : out("No PR yet", one("open", "Ask for the PR", true));
    return out(pr.isDraft ? "Draft PR" : "Waiting for review", one("pr", "Open PR", false));
  }
  const why = card.reason;
  switch (card.column) {
    case "queued":
      return out(why);
    case "working":
      return out(why, { busy: true });
    case "review":
      return out(why, one("pr", "Open PR", false));
    case "ready":
      return out(why === "Approved" ? "Approved, ready to merge" : why, one("pr", "Open PR", false));
    case "needs": {
      const bad = /fail|conflict|changes|gave up|stuck|error|wrong/i.test(why);
      if (pr && /changes/i.test(why) && t.lastSession) return out(why, { bad, ...one("review", "Answer the review", true) });
      if (card.session?.status === "waiting") return out(why, { bad, ...one("session", `Answer ${agent}`, true) });
      if (!pr && t.lastSession && !bad) return out(why, one("open", "Ask for the PR", true));
      return out(why, { bad, ...one("board", pr?.checks === "fail" ? "Fix checks" : "Open on Board", true) });
    }
    default:
      if (!pr && !t.lastSession) return out(`Worktree ready, no ${agent} yet`, one("agent", `Start ${agent}`, true));
      if (!pr) return out(`${why}, no PR yet`, one("open", "Ask for the PR", true));
      return out(why, one("pr", "Open PR", false));
  }
}

// A step of a feature: the same as any ticket until its PR is merged into the feature's branch; from there it waits
// on the feature's PR into a branch that ships. branch is the one it waits on, further up a stack.
export function placeFeature(t: Ticket, wt: string | undefined, pr: PullRequest, card: BoardCard | undefined, agent: string, stages: string[], where: string | undefined, featurePr: PullRequest | undefined, branch: string | undefined): Place {
  const p = prState(pr);
  const into = pr.base ?? "its feature branch";
  const up = branch && branch !== into ? ` (stacked: waiting on ${branch})` : "";
  const base = { bad: false, needsYou: false, shipping: false };
  if (!p.merged) {
    const r = placeCode(t, wt, pr, card, agent, [], undefined);
    return { ...r, at: Math.min(r.at, 4), next: `${r.next} · into ${into}`, shipping: false };
  }
  const reached = shipped(t, stages, where);
  if (reached) {
    const end = 6 + Math.max(1, stages.length);
    const at = 6 + reached;
    return { ...base, at, shipping: true, next: at >= end ? (stages.length ? `In ${stages.at(-1)!.toLowerCase()}` : "Done") : `${stages[reached - 1]} with ${into}`, actions: [] };
  }
  const fp = prState(featurePr);
  const open = featurePr ? [act("featurepr", `Feature PR #${featurePr.number}`)] : [];
  if (!featurePr) return { ...base, at: 5, next: branch && branch !== into ? `In ${into}, stacked on ${branch}, which has no PR to ship it yet` : `In ${into}, which has no PR to ship it yet`, actions: [] };
  if (fp.merged) return { ...base, at: 6, shipping: true, next: stages.length ? `${into} is merged, on its way to ${stages[0].toLowerCase()}` : `${into} is merged`, actions: open };
  if (featurePr.state !== "OPEN") return { ...base, at: 5, next: `In ${into}; PR #${featurePr.number} was closed without merging${up}`, actions: open };
  if (featurePr.checks === "fail") return { ...base, at: 5, bad: true, next: `In ${into}; the feature PR's checks are failing${up}`, actions: open };
  if (fp.changes) return { ...base, at: 5, bad: true, next: `In ${into}; ${fp.changes} asked for changes on the feature PR${up}`, actions: open };
  return { ...base, at: 5, next: `In ${into}; the feature PR ${featurePr.isDraft ? "is a draft" : fp.approved ? "is approved, ready to merge" : fp.waiting ? `waits on ${fp.waiting}` : "waits for review"}${up}`, actions: open };
}

// The Board card for a ticket: its worktree's, else any worktree, session or queued task with its key
export function cardOf(cards: BoardCard[], key: string, wt?: string) {
  if (wt) {
    const c = cards.find((x) => x.kind === "worktree" && x.path === wt);
    if (c) return c;
  }
  const mine = cards.filter((x) => x.ticket === key);
  return mine.find((x) => x.kind === "worktree") ?? mine.find((x) => x.kind === "session") ?? mine.find((x) => x.kind === "task");
}

// the newest PR per ticket; a closed one only when there's nothing else
export function newestPrs(prs: PullRequest[]) {
  const out = new Map<string, PullRequest>();
  for (const p of prs) {
    if (!p.ticket) continue;
    const had = out.get(p.ticket);
    if (!had || (had.state === "CLOSED" && p.state !== "CLOSED") || (had.state === p.state && p.number > had.number)) out.set(p.ticket, p);
  }
  return out;
}

// A feature step's PR goes into a branch that doesn't ship. Stacked branches merge into each other before one
// reaches a branch that does, so the chain is followed, and the step waits on the first PR in it not merged yet.
export function featureChain(pr: PullRequest, every: PullRequest[], shipping: string[]) {
  const chain: PullRequest[] = [];
  for (let b = pr.base; b && !shipping.includes(b) && chain.length < 10; ) {
    const next = every.filter((x) => x.branch === b && x.state !== "CLOSED").sort((a, c) => c.number - a.number)[0];
    if (!next) break;
    chain.push(next);
    b = next.base;
  }
  const featurePr = chain.find((x) => x.state !== "MERGED") ?? chain.at(-1);
  // the whole chain merged, but its last PR goes into another feature branch nobody has a PR for
  const last = chain.at(-1);
  const stuck = !!last && !chain.some((x) => x.state !== "MERGED") && !shipping.includes(last.base ?? "");
  return stuck ? { featurePr: undefined, branch: last.base } : { featurePr, branch: featurePr?.branch ?? pr.base };
}

const noCodeOf = (pattern: string) => {
  try {
    return pattern ? new RegExp(pattern, "i") : undefined;
  } catch {
    return undefined;
  }
};

// The tickets as plugins get them: with their worktree, newest PR and queued task
export function roadTickets(i: Pick<PipelineInput, "tickets" | "prs" | "worktrees" | "cards">): RoadTicket[] {
  const wtOf = new Map(i.worktrees.filter((w) => !w.main && w.ticket).map((w) => [w.ticket!, w]));
  const prOf = newestPrs(i.prs.mine);
  return i.tickets.map((t) => {
    const pr = prOf.get(t.key);
    // its own worktree, its epic's, or the one with its PR's branch checked out (a worktree holding a stack of PRs)
    const wt = wtOf.get(t.key) ?? (t.epic ? wtOf.get(t.epic) : undefined) ?? (pr ? i.worktrees.find((w) => !w.main && w.branch === pr.branch) : undefined);
    const task = cardOf(i.cards, t.key, wt?.path)?.task;
    return { ...t, worktree: wt?.path, node: wt?.node, pr, task: task && { id: task.id, status: task.status } };
  });
}

// Every ticket's row, plugins' roads first, then the feature and code roads
export function buildPipeline(i: PipelineInput): Pipeline {
  const warnings: Pipeline["warnings"] = [];
  const roads = new Map<string, { entry: RoadEntry; plugin: string }>();
  const where = new Map<string, string>();
  const badges = new Map<string, RoadBadge[]>();
  const more = new Map<string, RoadAction[]>();
  let stages: string[] = [];
  const extra: Ticket[] = [];
  for (const p of i.plugins) {
    if (p.error) warnings.push({ text: `${p.name} didn't answer (${p.error}), so what it adds to tickets isn't shown.`, plugin: p.plugin });
    for (const w of p.roads.warnings ?? []) warnings.push({ text: w, plugin: p.plugin });
    for (const r of p.roads.roads ?? []) if (!roads.has(r.key)) roads.set(r.key, { entry: r, plugin: p.plugin });
    for (const [k, v] of Object.entries(p.roads.where ?? {})) where.set(k, v);
    if (p.roads.stages?.length && !stages.length) stages = p.roads.stages;
    for (const [k, list] of Object.entries(p.roads.badges ?? {})) badges.set(k, [...(badges.get(k) ?? []), ...list]);
    for (const [k, list] of Object.entries(p.roads.actions ?? {})) more.set(k, [...(more.get(k) ?? []), ...list.map((a) => ({ ...a, plugin: p.plugin }))]);
    extra.push(...(p.roads.extra ?? []));
  }
  const known = new Set(i.tickets.map((t) => t.key));
  const offBoard = extra.filter((t, n) => !known.has(t.key) && extra.findIndex((x) => x.key === t.key) === n).map((t) => ({ ...t, offBoard: true }));
  const every = [...i.prs.mine, ...(i.prs.review ?? [])];
  const noCode = noCodeOf(i.noCode);
  const all = roadTickets({ ...i, tickets: [...i.tickets, ...offBoard] });

  const rows = all.map((rt): PipelineRow => {
    const r = placeRow(rt);
    const extra = more.get(rt.key);
    return extra ? { ...r, actions: [...r.actions, ...extra] } : r;
  });
  return { rows, warnings };

  function placeRow(rt: RoadTicket): PipelineRow {
    const { worktree: wt, node, pr, task: _task, ...ticket } = rt;
    const card = cardOf(i.cards, rt.key, wt);
    const common = {
      ticket,
      pr,
      worktree: wt,
      node,
      card: card?.id,
      session: rt.lastSession ? { id: rt.lastSession.id, status: rt.lastSession.status } : undefined,
      badges: badges.get(rt.key) ?? [],
    };
    const road = roads.get(rt.key);
    if (road) return { ...common, ...road.entry, actions: road.entry.actions ?? [], plugin: road.plugin };
    const w = where.get(rt.key);
    if (pr?.base && !i.mainBranches.includes(pr.base)) {
      const { featurePr, branch } = featureChain(pr, every, i.mainBranches);
      return { ...common, featurePr, key: rt.key, kind: "feature", kindLabel: "Feature step", steps: featureSteps(i.agent, stages), ...placeFeature(rt, wt, pr, card, i.agent, stages, w, featurePr, branch) };
    }
    if (!pr && !wt && (noCode?.test(rt.summary) || i.noCodeKeys?.has(rt.key))) return { ...common, key: rt.key, kind: "nocode", kindLabel: "No code", steps: [], at: 0, next: "No code: nothing to ship", actions: rt.url ? [{ id: "ticket", label: "Ticket", href: rt.url }] : [] };
    return { ...common, key: rt.key, kind: "code", steps: codeSteps(i.agent, stages), ...placeCode(rt, wt, pr, card, i.agent, stages, w) };
  }
}
