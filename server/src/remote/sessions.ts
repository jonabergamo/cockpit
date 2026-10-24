// The hub's view of its nodes' Claude sessions. Each node indexes its own ~/.claude; the hub keeps a copy of
// each node's list (refreshed every minute, and the live ones as the node pushes them) so screens that list
// sessions show them all, and reads transcripts, subagents and search results from the node that has them.
import type { Session } from "@cockpit/shared";
import { searchSessions } from "../claude/search.ts";
import { getSession, listSessions, useRemoteSessions } from "../claude/sessions.ts";
import { broadcast } from "../hub.ts";
import type { RemoteLink } from "./link.ts";

const REFRESH_MS = 60_000;
const LIMIT = 500;

interface Node {
  link: RemoteLink;
  sessions: Map<string, Session>;
  timer?: NodeJS.Timeout;
}

const nodes = new Map<string, Node>();
let registered = false;

const tag = (machine: string, s: Session): Session => ({ ...s, node: machine });
// while its node can't be reached nothing is known to be running, so nothing counts as working or waiting
const reachable = (n: Node, s: Session): Session => (n.link.status.state === "up" || s.status === "ended" ? s : { ...s, status: "ended", waitingFor: undefined });
const announce = () => broadcast({ type: "sessions", sessions: listSessions({ liveOnly: true }) });

function register() {
  if (registered) return;
  registered = true;
  useRemoteSessions({
    list: () => [...nodes.values()].flatMap((n) => [...n.sessions.values()].map((s) => reachable(n, s))),
    get: (id) => {
      for (const n of nodes.values()) {
        const s = n.sessions.get(id);
        if (s) return reachable(n, s);
      }
    },
  });
}

async function refresh(machine: string) {
  const n = nodes.get(machine);
  if (!n || n.link.status.state !== "up") return;
  const list = await n.link.request<Session[]>("sessions.list", { limit: LIMIT }).catch(() => undefined);
  if (!list) return;
  n.sessions = new Map(list.map((s) => [s.id, tag(machine, s)]));
  announce();
}

// The live ones as the node sees them now; one that dropped out of that list has ended
function live(machine: string, list: Session[]) {
  const n = nodes.get(machine);
  if (!n) return;
  const now = new Set(list.map((s) => s.id));
  for (const [id, s] of n.sessions) if (s.status !== "ended" && !now.has(id)) n.sessions.set(id, { ...s, status: "ended", pid: undefined, term: undefined });
  for (const s of list) n.sessions.set(s.id, tag(machine, s));
  announce();
}

export function addSessionLink(machine: string, link: RemoteLink) {
  register();
  clearInterval(nodes.get(machine)?.timer);
  const n: Node = { link, sessions: nodes.get(machine)?.sessions ?? new Map() };
  nodes.set(machine, n);
  // its sessions stop counting as live while it's away, and count again once it's back
  link.onStatus((st) => st.state !== "up" && nodes.get(machine) === n && announce());
  link.onUp((c) => {
    c.on("sessions", (list: Session[]) => live(machine, list));
    void refresh(machine);
  });
  // refresh() does nothing while the link is down, so this runs for as long as the machine is here
  n.timer = setInterval(() => void refresh(machine), REFRESH_MS);
  n.timer.unref?.();
}

export function removeSessionLink(machine: string) {
  clearInterval(nodes.get(machine)?.timer);
  nodes.delete(machine);
  announce();
}

// One of a node's sessions that isn't in the copy, being older than the newest it sends (search finds those):
// asked of each connected node by its id, and kept once one has it
export async function findSession(id: string) {
  if (!nodes.size || getSession(id)) return;
  for (const [machine, n] of nodes) {
    if (n.link.status.state !== "up") continue;
    const s = await n.link.request<Session | null>("session.get", { id }).catch(() => null);
    if (s) return void n.sessions.set(s.id, tag(machine, s));
  }
}

// the node a session ran on, if it isn't this machine
export function machineOf(sessionId: string) {
  for (const [machine, n] of nodes) if (n.sessions.has(sessionId)) return machine;
}

export function requestOn<T>(machine: string, m: string, a?: unknown) {
  const n = nodes.get(machine);
  if (!n) return Promise.reject(Object.assign(new Error(`No machine called ${machine}`), { status: 404 }));
  return n.link.request<T>(m, a);
}

// one thing about a session, from the node it ran on or from this machine
export async function onNode<T>(sessionId: string, remote: (n: { request: <R>(m: string, a?: unknown) => Promise<R> }) => Promise<T>, local: () => T | Promise<T>): Promise<T> {
  await findSession(sessionId);
  const machine = machineOf(sessionId);
  if (!machine) return Promise.resolve(local());
  return remote({ request: (m, a) => requestOn(machine, m, a) });
}

type Hit = ReturnType<typeof searchSessions>[number] & { node?: string };

// this machine's transcripts and every connected node's, most recent first
export async function searchEverywhere(q: string, limit = 20, any = false) {
  const mine: Hit[] = searchSessions(q, limit, any);
  const theirs = await Promise.all(
    [...nodes].map(([machine, n]) =>
      n.link.status.state === "up"
        ? n.link
            .request<Hit[]>("sessions.search", { q, limit, any })
            .then((hits) => hits.map((h) => ({ ...h, node: machine })))
            .catch(() => [] as Hit[])
        : ([] as Hit[]),
    ),
  );
  return [...mine, ...theirs.flat()].sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? "")).slice(0, limit);
}
