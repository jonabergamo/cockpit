// The hub's view of its nodes' terminals. Each one shows next to this machine's own: its output is followed over
// the link into a copy here, so a browser can open it at any time, and a link that drops leaves the terminals
// "disconnected" (still running on the node, only out of reach) until it's back. Coming back picks up from the
// last character the hub had, or starts over when the node can't give it any more.
import type { TermInfo } from "@cockpit/shared";
import type { WebSocket } from "ws";
import { send } from "../hub.ts";
import { announce, useRemoteTerms, type PtyFrame } from "../pty.ts";
import type { SpawnOpts } from "./host.ts";
import type { RemoteLink } from "./link.ts";

const MAX = 1024 * 1024;

interface RemoteTerm {
  info: TermInfo;
  machine: string;
  epoch?: number;
  // offsets of the first and next character the copy holds
  start: number;
  end: number;
  buf: string;
  tmux: boolean;
  sockets: Set<WebSocket>;
  following: boolean;
}

interface Node {
  link: RemoteLink;
  terms: Map<string, RemoteTerm>;
}

const nodes = new Map<string, Node>();
const owner = new Map<string, RemoteTerm>();

const up = (n: Node) => n.link.status.state === "up";
const view = (rt: RemoteTerm): TermInfo => rt.info;

function forget(rt: RemoteTerm, code?: number) {
  owner.delete(rt.info.id);
  nodes.get(rt.machine)?.terms.delete(rt.info.id);
  if (code !== undefined) for (const ws of rt.sockets) send(ws, { type: "pty.exit", id: rt.info.id, code });
}

// the node's list, as it is now; what's missing from it ended while the hub wasn't looking
function sync(machine: string, list: TermInfo[]) {
  const n = nodes.get(machine);
  if (!n) return;
  const seen = new Set<string>();
  for (const i of list) {
    seen.add(i.id);
    const info: TermInfo = { ...i, node: machine, state: i.exited === undefined ? "running" : "exited" };
    const rt = n.terms.get(i.id);
    if (rt) rt.info = info;
    else {
      const fresh: RemoteTerm = { info, machine, start: 0, end: 0, buf: "", tmux: true, sockets: new Set(), following: false };
      n.terms.set(i.id, fresh);
      owner.set(i.id, fresh);
    }
  }
  for (const rt of [...n.terms.values()]) if (!seen.has(rt.info.id)) forget(rt, -1);
  announce();
}

function reset(rt: RemoteTerm, f: PtyFrame) {
  rt.epoch = f.epoch;
  rt.start = rt.end = f.offset;
  rt.buf = "";
  for (const ws of rt.sockets) send(ws, { type: "pty.reset", id: rt.info.id });
}

// A frame lands in the copy where its offset says: one from a new tmux client, or after a gap the node couldn't
// fill, starts over; one that overlaps what's here already only adds its new part
export function onFrame(rt: Pick<RemoteTerm, "epoch" | "start" | "end" | "buf" | "info" | "sockets">, f: PtyFrame) {
  if (f.epoch !== rt.epoch || f.offset > rt.end) reset(rt as RemoteTerm, f);
  const data = f.offset < rt.end ? f.data.slice(rt.end - f.offset) : f.data;
  if (!data) return;
  rt.end += data.length;
  rt.buf += data;
  if (rt.buf.length > MAX) {
    rt.start += rt.buf.length - MAX;
    rt.buf = rt.buf.slice(-MAX);
  }
  for (const ws of rt.sockets) send(ws, { type: "pty.data", id: rt.info.id, data });
}

async function follow(rt: RemoteTerm) {
  const n = nodes.get(rt.machine);
  if (!n || !up(n) || rt.following) return;
  rt.following = true;
  try {
    const r = await n.link.request<{ gone?: boolean; tmux?: boolean }>("pty.sub", { id: rt.info.id, from: rt.epoch === undefined ? undefined : { epoch: rt.epoch, offset: rt.end } });
    if (r.gone) {
      forget(rt, -1);
      announce();
    } else rt.tmux = r.tmux ?? true;
  } catch {
    rt.following = false;
  }
}

// a link that drops leaves its terminals listed, marked disconnected; one that comes back lists them again
function linked(machine: string, link: RemoteLink) {
  const n: Node = { link, terms: nodes.get(machine)?.terms ?? new Map() };
  nodes.set(machine, n);
  link.onStatus((s) => {
    if (s.state === "up") return;
    let any = false;
    for (const rt of n.terms.values()) {
      rt.following = false;
      if (rt.info.state === "running") (rt.info = { ...rt.info, state: "disconnected" }), (any = true);
    }
    if (any) announce();
  });
  link.onUp(async (c) => {
    c.on("terms", (list: TermInfo[]) => sync(machine, list));
    c.on("pty", (f: PtyFrame) => {
      const rt = n.terms.get(f.id);
      if (rt) onFrame(rt, f);
    });
    c.on("pty.exit", ({ id, code }: { id: string; code: number }) => {
      const rt = n.terms.get(id);
      if (rt) for (const ws of rt.sockets) send(ws, { type: "pty.exit", id, code });
    });
    try {
      sync(machine, await c.request<TermInfo[]>("term.list"));
    } catch {
      return;
    }
    // whatever a browser has open picks up where it left off
    for (const rt of n.terms.values()) if (rt.sockets.size) void follow(rt);
  });
}

export function unlinked(machine: string) {
  const n = nodes.get(machine);
  if (!n) return;
  for (const rt of [...n.terms.values()]) forget(rt, -1);
  nodes.delete(machine);
  announce();
}

const call = (rt: RemoteTerm | undefined, m: string, a: unknown) => {
  const n = rt && nodes.get(rt.machine);
  if (n && up(n)) n.link.request(m, a).catch(() => {});
};

export function startRemoteTerms(links: Map<string, RemoteLink> | Iterable<[string, RemoteLink]>) {
  for (const [machine, link] of links) linked(machine, link);
  useRemoteTerms({
    list: () => [...owner.values()].map(view),
    owns: (id) => owner.has(id),
    attach(ws, id) {
      const rt = owner.get(id)!;
      rt.sockets.add(ws);
      send(ws, { type: "pty.mode", id, tmux: rt.tmux });
      send(ws, { type: "pty.reset", id });
      if (rt.buf) send(ws, { type: "pty.data", id, data: rt.buf });
      void follow(rt);
    },
    detachAll(ws) {
      for (const rt of owner.values()) {
        if (!rt.sockets.delete(ws) || rt.sockets.size) continue;
        // nobody's watching any more: stop streaming it, the copy stays for next time
        const n = nodes.get(rt.machine);
        if (n && up(n) && rt.following) n.link.channel?.emit("pty.unsub", { id: rt.info.id });
        rt.following = false;
      }
    },
    // typing only goes through while the node can be reached; the browser blocks it while disconnected
    input(id, data) {
      const rt = owner.get(id);
      const n = rt && nodes.get(rt.machine);
      if (n && up(n)) n.link.channel?.emit("pty.in", { id, data });
    },
    resize: (id, cols, rows) => call(owner.get(id), "term.resize", { id, cols, rows }),
    scroll: (id, lines) => call(owner.get(id), "term.scroll", { id, lines }),
    search: (id, query, step) => call(owner.get(id), "term.search", { id, query, step }),
    kill(id) {
      const rt = owner.get(id);
      call(rt, "term.kill", { id });
      if (rt) forget(rt);
      announce();
    },
    cwd: (id) => owner.get(id)?.info.cwd,
  });
}

export const addLink = (machine: string, link: RemoteLink) => linked(machine, link);

// a terminal opened on a node from here
export async function spawnRemote(machine: string, opts: SpawnOpts) {
  const n = nodes.get(machine);
  if (!n) throw Object.assign(new Error(`No machine called ${machine}`), { status: 404 });
  if (!up(n)) throw Object.assign(new Error(`${machine} isn't connected right now`), { status: 503 });
  const info = await n.link.request<TermInfo>("term.spawn", opts);
  sync(machine, await n.link.request<TermInfo[]>("term.list"));
  return owner.get(info.id)?.info ?? { ...info, node: machine };
}

// the node's list now, rather than when it next says it changed
export async function refreshTerms(machine: string) {
  const n = nodes.get(machine);
  if (n && up(n)) sync(machine, await n.link.request<TermInfo[]>("term.list"));
}
