// The node side of a link: who this machine is, which hubs it's paired with, and the listener a hub dials. A
// node is always on, so it waits and the hub (a laptop that sleeps) dials it.
// Pairing lives in <data>/node.json: { id, name, hubs: [{ hub, key, pairedAt }] }, where key is the hash of the
// token the hub showed. `cockpit node pair` writes it; it's read again on every connection, so pairing needs no
// restart.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { config, paths } from "../config.ts";
import { slugify } from "../util.ts";
import { currentCwd, input, kill, localTerms, onTermExit, onTermsChanged, resize, scroll, search, spawnTerm, subscribe } from "../pty.ts";
import type { SpawnOpts } from "./host.ts";
import { localHost } from "./local.ts";
import { Channel, keyOf, macOk, newNonce, PROTOCOL, type Frame, type NodeInfo, type Wire } from "./protocol.ts";

export interface Pairing {
  id: string;
  name: string;
  hubs: { hub: string; key: string; pairedAt: number }[];
}

const file = () => join(paths.data, "node.json");
const VERSION = "0.1.0";

export function pairing(): Pairing {
  try {
    const p = JSON.parse(readFileSync(file(), "utf8")) as Pairing;
    if (p.id && Array.isArray(p.hubs)) return p;
  } catch {}
  const name = hostname();
  const p: Pairing = { id: slugify(name, 24) || "node", name, hubs: [] };
  if (!existsSync(file())) save(p);
  return p;
}

function save(p: Pairing) {
  writeFileSync(file(), JSON.stringify(p, null, 2));
  try {
    chmodSync(file(), 0o600);
  } catch {}
}

// remembers a hub; replace drops every other hub, so the old one can't connect any more
export function pair(hub: string, token: string, replace = false) {
  if (!/^[\w-]{4,64}$/.test(hub)) throw new Error("That isn't a hub id");
  if (token.length < 20) throw new Error("That isn't a pairing token");
  const p = pairing();
  const others = p.hubs.filter((h) => h.hub !== hub);
  if (others.length && !replace) throw new Error(`This node is paired with another hub already (${others.map((h) => h.hub).join(", ")}). Pass --replace to move it to this one.`);
  p.hubs = [{ hub, key: keyOf(token), pairedAt: Date.now() }];
  save(p);
  return p;
}

export const nodeInfo = (): NodeInfo => ({ hostname: hostname(), platform: `${process.platform}-${process.arch}`, version: VERSION, terminals: localHost.terminals.list().filter((t) => t.state === "running").length });

// Tailscale's addresses are 100.64.0.0/10; with listen = tailscale only those and this machine may connect
export function fromTailnet(addr = "") {
  const ip = addr.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1") return true;
  const m = ip.match(/^100\.(\d+)\./);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

// one handshake: hello with a nonce, the hub's HMAC back, then welcome or refuse
export function accept(wire: Wire, opts: { remote?: string; onChannel: (c: Channel, hub: string) => void; heartbeatMs?: number; deadMs?: number }) {
  const me = pairing();
  const nonce = newNonce();
  let done = false;
  const refuse = (why: string, code = 4003) => {
    done = true;
    try {
      wire.send(JSON.stringify({ t: "refuse", why } satisfies Frame));
    } catch {}
    wire.close(code, why);
  };
  const timer = setTimeout(() => !done && refuse("no answer to hello"), 10_000);
  timer.unref?.();
  wire.onMessage((raw) => {
    if (done) return;
    let f: Frame;
    try {
      f = JSON.parse(raw);
    } catch {
      return refuse("not a cockpit hub");
    }
    if (f.t !== "auth") return refuse("expected auth");
    clearTimeout(timer);
    if (f.protocol !== PROTOCOL) return refuse(`this node speaks link version ${PROTOCOL} and the hub ${f.protocol}; update the older one`, 4002);
    const paired = pairing().hubs.find((h) => h.hub === f.hub);
    if (!paired || !macOk(paired.key, nonce, f.hub, f.mac)) return refuse("this node isn't paired with that hub, or the token is wrong; pair it again", 4001);
    done = true;
    wire.send(JSON.stringify({ t: "welcome", node: me.id, info: nodeInfo() } satisfies Frame));
    opts.onChannel(new Channel(wire, { heartbeatMs: opts.heartbeatMs, deadMs: opts.deadMs }), f.hub);
  });
  wire.send(JSON.stringify({ t: "hello", node: me.id, name: me.name, nonce, protocol: PROTOCOL, version: VERSION } satisfies Frame));
}

export const wsWire = (ws: WebSocket): Wire => ({
  send: (d) => ws.send(d),
  close: (code, why) => ws.close(code, why),
  onMessage: (fn) => ws.on("message", (d) => fn(d.toString())),
  onClose: (fn) => ws.on("close", (code, why) => fn(code, why.toString())),
});

// what a node answers once a hub is in: about itself, and its terminals, which the hub shows as its own
export function serve(c: Channel) {
  c.handle("info", () => nodeInfo());
  c.handle("term.list", () => localTerms());
  c.handle("term.spawn", (o: SpawnOpts) => spawnTerm(o));
  c.handle("term.kill", ({ id }: { id: string }) => kill(id));
  c.handle("term.resize", ({ id, cols, rows }: { id: string; cols: number; rows: number }) => resize(id, cols, rows));
  c.handle("term.scroll", ({ id, lines }: { id: string; lines: number }) => scroll(id, lines));
  c.handle("term.search", ({ id, query, step }: { id: string; query: string; step: "find" | "next" | "prev" | "close" }) => search(id, query, step));
  c.handle("term.cwd", ({ id }: { id: string }) => currentCwd(id) ?? null);
  // typing has no answer to wait for
  c.on("pty.in", ({ id, data }: { id: string; data: string }) => input(id, data));
  // following a terminal: from where the hub left off when it can, else from the start of the scrollback
  const subs = new Map<string, () => void>();
  c.handle("pty.sub", ({ id, from }: { id: string; from?: { epoch: number; offset: number } }) => {
    subs.get(id)?.();
    const s = subscribe(id, from, (f) => c.emit("pty", f));
    if (!s) return { gone: true };
    subs.set(id, s.off);
    return { mode: s.mode, epoch: s.epoch, start: s.start, tmux: s.tmux };
  });
  c.on("pty.unsub", ({ id }: { id: string }) => (subs.get(id)?.(), subs.delete(id)));
  const offTerms = onTermsChanged(() => c.emit("terms", localTerms()));
  const offExit = onTermExit((id, code) => c.emit("pty.exit", { id, code }));
  c.onClose(() => {
    for (const off of subs.values()) off();
    offTerms();
    offExit();
  });
}

// the hubs connected right now, for pushing events to them
export const hubs = new Set<Channel>();

async function addresses(listen: string) {
  if (listen === "all") return ["0.0.0.0"];
  if (listen !== "tailscale") return [listen];
  const ts = await localHost.exec("tailscale", ["ip", "-4"]).then((o) => o.trim().split("\n")[0], () => "");
  if (!ts) console.warn("node: no Tailscale address found, listening on loopback only");
  return ["127.0.0.1", ...(ts ? [ts] : [])];
}

export async function startNodeServer() {
  const listen = config.node.listen;
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    accept(wsWire(ws), {
      remote: req.socket.remoteAddress,
      onChannel: (c, hub) => {
        hubs.add(c);
        c.onClose(() => hubs.delete(c));
        serve(c);
        console.log(`node: hub ${hub} connected from ${req.socket.remoteAddress}`);
      },
    });
  });
  const servers: Server[] = [];
  for (const host of await addresses(listen)) {
    const s = createServer((_req, res) => res.writeHead(426).end("cockpit node: connect with a websocket on /node\n"));
    s.on("upgrade", (req, socket, head) => {
      if (req.url !== "/node" || (listen === "tailscale" && !fromTailnet(req.socket.remoteAddress))) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    s.listen(config.node.port, host, () => console.log(`node ${pairing().id} waiting for its hub on ${host}:${config.node.port}`));
    s.on("error", (e) => console.error(`node: can't listen on ${host}:${config.node.port}:`, e.message));
    servers.push(s);
  }
  return servers;
}
