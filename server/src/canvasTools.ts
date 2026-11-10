// The canvas as the lead session sees it through cockpit's MCP tools: which card a worker is on, the cards and lines
// of each workspace in a few words, and Codex or the local model opened beside a worker the way its + menu does.
// A worker is named the way the other tools name it: a task, a session, a worktree, a terminal or a card id.
import type { CanvasInfo, CanvasNode, Task, TermInfo } from "@cockpit/shared";
import { agentTerm, modelName } from "@cockpit/shared";
import * as canvas from "./canvas.ts";

export interface FindCtx {
  canvases: CanvasInfo[];
  terms: TermInfo[];
  tasks: Pick<Task, "id" | "group" | "termId" | "sessionId" | "worktree">[];
  sessions: { id: string; term?: string }[];
}

export type Found = { canvas: string; workspace: string; node: CanvasNode; term?: TermInfo };

const GAP = 40;
const within = (path: string, root: string) => path === root || path.startsWith(root + "/");
const AGENT = /^(?:\S*\/)?(?:claude|codex|gemini)(?:\s|$)/;
const running = (t: TermInfo) => t.exited === undefined && t.state !== "exited";

// Of the terminals in one worktree, the worker's: a running one with a session, an agent rather than a shell or a
// reviewer beside it, the first opened
const rank = (t: TermInfo) => [running(t) ? 0 : 1, t.session ? 0 : 1, AGENT.test(t.command) ? 0 : 1, /review/i.test(t.title) ? 1 : 0, t.createdAt];
function best(terms: TermInfo[]) {
  return [...terms].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  })[0];
}

export function findCard(who: string, ctx: FindCtx): Found {
  const w = who.trim();
  if (!w) throw new Error("Say which worker: a task id, a session id, a worktree path, a terminal id or a card id from canvas_view");
  const cardOf = (pred: (n: CanvasNode) => boolean) => {
    for (const c of ctx.canvases) {
      const node = c.nodes.find(pred);
      if (node) return { canvas: c.id, workspace: c.name, node, term: node.kind === "term" ? ctx.terms.find((t) => t.id === node.ref) : undefined };
    }
  };
  const onCanvas = (t: TermInfo) => {
    const f = cardOf((n) => n.kind === "term" && n.ref === t.id);
    if (!f) throw new Error(`The terminal "${t.title}" (${t.id}) isn't on the canvas yet. Try again in a moment`);
    return f;
  };
  const byCard = cardOf((n) => n.id === w);
  if (byCard) return byCard;
  const bare = w.replace(/^[st]:/, "");
  const byTerm = (id?: string) => (id ? ctx.terms.find((t) => t.id === id) : undefined);
  const bySession = (id?: string) => (id ? (ctx.terms.find((t) => t.session === id) ?? byTerm(ctx.sessions.find((s) => s.id === id)?.term)) : undefined);
  const inPath = (path?: string) => {
    const root = path?.replace(/\/+$/, "");
    return root ? best(ctx.terms.filter((t) => within(t.cwd, root))) : undefined;
  };
  // a task by its id, or a group with a single attempt
  const group = ctx.tasks.filter((t) => t.group === bare);
  const task = ctx.tasks.find((t) => t.id === bare) ?? (group.length === 1 ? group[0] : undefined);
  if (task) {
    const t = byTerm(task.termId) ?? bySession(task.sessionId) ?? inPath(task.worktree);
    if (!t) throw new Error(`Task ${task.id} has no terminal open${task.worktree ? ` in ${task.worktree}` : ""}, so it has no card on the canvas`);
    return onCanvas(t);
  }
  if (group.length > 1) throw new Error(`${bare} is a group of ${group.length} attempts: name one of its tasks (${group.map((t) => t.id).join(", ")})`);
  const t = byTerm(bare) ?? bySession(bare) ?? (w.startsWith("/") ? inPath(w) : undefined);
  if (t) return onCanvas(t);
  // a ticket's card, by its key
  const ticket = cardOf((n) => n.kind === "ticket" && n.ref === w.toUpperCase());
  if (ticket) return ticket;
  throw new Error(`Nothing on the canvas matches "${w}". Use a task id, a session id, a worktree path, a terminal id or a card id from canvas_view`);
}

// what a line does, in words: which way its turns go, what the other end is asked, and how the last one went
const way = { source: "from → to", target: "to → from", both: "both ways" } as const;

// The workspaces, their cards and lines, with only what a lead needs to read the topology
export function canvasView(canvases: CanvasInfo[], terms: TermInfo[], noteText: (node: string) => string | undefined = canvas.readNote, only?: string) {
  const term = new Map(terms.map((t) => [t.id, t]));
  const want = only?.trim().toLowerCase();
  return canvases
    .filter((c) => !want || c.id === only || c.name.toLowerCase() === want)
    .map((c) => {
      const label = new Map<string, string>();
      const cards = c.nodes.map((n) => {
        const base = { id: n.id, kind: n.kind, ...(n.archived ? { archived: true } : {}) };
        if (n.kind === "term") {
          const t = term.get(n.ref);
          label.set(n.id, t?.title ?? "a closed terminal");
          return { ...base, title: t?.title, terminal: n.ref, cwd: t?.cwd, session: t?.session, machine: t?.node && t.node !== "local" ? t.node : undefined, state: t ? (t.state ?? (t.exited === undefined ? "running" : "exited")) : "gone" };
        }
        if (n.kind === "note") {
          const text = (noteText(n.id) ?? "").trim();
          label.set(n.id, `note "${text.slice(0, 30)}"`);
          return { ...base, text: text.length > 600 ? `${text.slice(0, 600)}…` : text };
        }
        if (n.kind === "ticket") {
          label.set(n.id, n.ref);
          return { ...base, ticket: n.ref };
        }
        label.set(n.id, `${n.kind} card`);
        return base;
      });
      const lines = c.edges.map((e) => ({
        id: e.id,
        from: e.source,
        to: e.target,
        between: `${label.get(e.source) ?? e.source} → ${label.get(e.target) ?? e.target}`,
        ...(e.relay
          ? {
              role: e.relay.role,
              goes: way[e.relay.from],
              when: e.relay.when && e.relay.when !== "every" ? e.relay.when : undefined,
              hops: `${e.hops ?? 0} of ${e.relay.limit}`,
              withDiff: e.relay.role === "review" ? e.relay.withDiff !== false : undefined,
              prompt: e.relay.prompt,
            }
          : { role: "plain line" }),
        last: e.status ? `${e.status.state}: ${e.status.text}` : undefined,
      }));
      return { id: c.id, name: c.name, cards, lines };
    });
}

export type BesideAgent = "codex" | "local";
// chat: a line it can be talked over; reviewer: each turn the worker finishes goes to it and the review comes back;
// review: a one-off, read-only review of the folder's changes
export type BesideAs = "chat" | "reviewer" | "review";

export interface BesideDeps {
  quick: { model?: string; url?: string };
  base: string;
  cwdNow: (term: string) => string | undefined;
  spawn: (opts: { cwd: string; title: string; command: string; args: string[]; node?: string }) => Promise<{ id: string }>;
}

// Codex or the local model beside a worker's terminal, in the folder it's in now, linked to it by a line, as the
// + menu on its card opens them
export async function openBeside(found: Found, agent: BesideAgent, as: BesideAs, deps: BesideDeps) {
  const from = found.node;
  const t = found.term;
  if (from.kind !== "term" || !t) throw new Error(`That's a ${from.kind} card, not a terminal: name the worker's terminal`);
  if (!running(t)) throw new Error(`"${t.title}" has exited, so there's nothing to open beside it`);
  if (as !== "chat" && as !== "reviewer" && as !== "review") throw new Error("as is chat, reviewer or review");
  const cmd = agentTerm(agent, { model: deps.quick.model || undefined, url: deps.quick.url, base: deps.base, review: as === "review" });
  const cwd = deps.cwdNow(t.id) ?? t.cwd;
  const folder = cwd.split("/").filter(Boolean).pop() ?? cwd;
  const title = `${as === "reviewer" ? `${agent === "local" ? modelName(deps.quick.model ?? "") : "Codex"} review` : cmd.title} · ${folder}`;
  const node = t.node && t.node !== "local" ? t.node : undefined;
  const open = (dir: string) => deps.spawn({ cwd: dir, title, command: cmd.command, args: cmd.args, node });
  // a shell that cd'd somewhere cockpit doesn't open terminals in: the folder it started in instead
  const made = await open(cwd).catch((e) => (cwd !== t.cwd ? open(t.cwd) : Promise.reject(e)));
  const card = canvas.placeTerm(found.canvas, made.id, { x: from.x + from.w + GAP, y: from.y });
  const line = canvas.addEdge(found.canvas, from.id, card.id);
  // both ways: its turns go to the reviewer, and the review comes back to act on
  if (as === "reviewer") canvas.setRelay(line.id, { from: "both", role: "review", limit: 4 });
  return { workspace: found.workspace, terminal: made.id, card: card.id, line: line.id, title };
}
