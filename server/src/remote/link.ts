// The hub side of a link to one node: dial it, prove the pairing, keep the heartbeat, and dial again when it
// drops, sooner after this machine wakes from sleep (a timer that fires far too late means it slept).
import { WebSocket } from "ws";
import { Channel, keyOf, macOf, PROTOCOL, type Frame, type NodeInfo, type Wire } from "./protocol.ts";
import { wsWire } from "./node.ts";

export type LinkState = "connecting" | "up" | "down" | "refused";

export interface LinkStatus {
  state: LinkState;
  node?: string;
  info?: NodeInfo;
  rtt?: number;
  // when it last went up or down
  since: number;
  error?: string;
}

export interface LinkOpts {
  url: string;
  token: string;
  hub: string;
  dial?: (url: string) => Wire;
  heartbeatMs?: number;
  deadMs?: number;
  // the slowest it waits between tries
  maxBackoffMs?: number;
}

const dialWs = (url: string): Wire => {
  const ws = new WebSocket(url, { handshakeTimeout: 8000 });
  const wire = wsWire(ws);
  // a send before the socket opens is held until it does
  const queue: string[] = [];
  ws.on("open", () => queue.splice(0).forEach((d) => ws.send(d)));
  ws.on("error", () => {});
  return { ...wire, send: (d) => (ws.readyState === WebSocket.OPEN ? ws.send(d) : queue.push(d)) };
};

// handshake from the hub's side: wait for hello, answer with the HMAC, then welcome or refuse
export function handshake(wire: Wire, o: { token: string; hub: string; heartbeatMs?: number; deadMs?: number }) {
  return new Promise<{ channel: Channel; node: string; info: NodeInfo }>((ok, fail) => {
    let stage: "hello" | "welcome" | "done" = "hello";
    const timer = setTimeout(() => {
      stage = "done";
      wire.close(4000, "handshake timed out");
      fail(new Error("the node didn't answer"));
    }, 12_000);
    wire.onClose((_c, why) => {
      if (stage === "done") return;
      stage = "done";
      clearTimeout(timer);
      fail(Object.assign(new Error(why || "the node closed the link"), { refused: !!why }));
    });
    wire.onMessage((raw) => {
      if (stage === "done") return;
      let f: Frame;
      try {
        f = JSON.parse(raw);
      } catch {
        return;
      }
      if (f.t === "refuse") {
        stage = "done";
        clearTimeout(timer);
        return fail(Object.assign(new Error(f.why), { refused: true }));
      }
      if (stage === "hello" && f.t === "hello") {
        if (f.protocol !== PROTOCOL) {
          stage = "done";
          clearTimeout(timer);
          wire.close(4002, "version");
          return fail(Object.assign(new Error(`the node speaks link version ${f.protocol} and this hub ${PROTOCOL}; update the older one`), { refused: true }));
        }
        stage = "welcome";
        wire.send(JSON.stringify({ t: "auth", hub: o.hub, mac: macOf(keyOf(o.token), f.nonce, o.hub), protocol: PROTOCOL } satisfies Frame));
        return;
      }
      if (stage === "welcome" && f.t === "welcome") {
        stage = "done";
        clearTimeout(timer);
        ok({ channel: new Channel(wire, { heartbeatMs: o.heartbeatMs, deadMs: o.deadMs }), node: f.node, info: f.info });
      }
    });
  });
}

export class RemoteLink {
  status: LinkStatus = { state: "connecting", since: Date.now() };
  channel?: Channel;
  private tries = 0;
  private timer?: NodeJS.Timeout;
  private wake?: NodeJS.Timeout;
  private stopped = false;
  private watchers = new Set<(s: LinkStatus) => void>();
  private ups = new Set<(c: Channel) => void>();

  constructor(private o: LinkOpts) {}

  start() {
    this.stopped = false;
    // a 2s timer that fires much later than that means the machine was asleep: the link is dead, dial now
    let last = Date.now();
    this.wake = setInterval(() => {
      const now = Date.now();
      if (now - last > 8000) this.retry();
      last = now;
    }, 2000);
    this.wake.unref?.();
    this.dial();
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.wake);
    this.channel?.kill("removed");
  }

  // dial again now, whatever the backoff says
  retry() {
    if (this.stopped) return;
    this.tries = 0;
    clearTimeout(this.timer);
    if (this.channel?.up) this.channel.kill("woke up");
    else this.dial();
  }

  onStatus(fn: (s: LinkStatus) => void) {
    this.watchers.add(fn);
    return () => void this.watchers.delete(fn);
  }

  // runs on every connection, the first and each reconnect, to set the channel up
  onUp(fn: (c: Channel) => void) {
    this.ups.add(fn);
    if (this.channel?.up) fn(this.channel);
    return () => void this.ups.delete(fn);
  }

  request<T>(m: string, a?: unknown) {
    if (!this.channel?.up) return Promise.reject(Object.assign(new Error(`${this.status.node ?? "the node"} isn't connected`), { status: 503 }));
    return this.channel.request<T>(m, a);
  }

  private set(patch: Partial<LinkStatus>) {
    const changed = patch.state && patch.state !== this.status.state;
    this.status = { ...this.status, ...patch, ...(changed ? { since: Date.now() } : {}) };
    for (const fn of this.watchers) fn(this.status);
  }

  private dial() {
    if (this.stopped) return;
    this.set({ state: this.status.state === "up" ? "down" : this.status.state === "refused" ? "refused" : "connecting" });
    let wire: Wire;
    try {
      wire = (this.o.dial ?? dialWs)(this.o.url);
    } catch (e) {
      return this.later((e as Error).message);
    }
    handshake(wire, this.o).then(
      ({ channel, node, info }) => {
        this.tries = 0;
        this.channel = channel;
        this.set({ state: "up", node, info, error: undefined, rtt: undefined });
        const rtt = setInterval(() => channel.rtt !== undefined && channel.rtt !== this.status.rtt && this.set({ rtt: channel.rtt }), 10_000);
        rtt.unref?.();
        channel.onClose((why) => {
          clearInterval(rtt);
          if (this.channel === channel) this.channel = undefined;
          if (this.stopped) return;
          this.set({ state: "down", error: why });
          this.later();
        });
        for (const fn of this.ups) fn(channel);
      },
      (e: Error & { refused?: boolean }) => {
        // a refusal (wrong token, other version) won't fix itself quickly, so it's tried far less often
        if (e.refused) this.set({ state: "refused", error: e.message });
        this.later(e.message, e.refused);
      },
    );
  }

  private later(error?: string, slow = false) {
    if (this.stopped) return;
    if (error && this.status.state !== "refused") this.set({ state: this.status.state === "up" ? "down" : this.status.state, error });
    const max = this.o.maxBackoffMs ?? 30_000;
    const base = slow ? max : Math.min(max, 1000 * 2 ** this.tries++);
    // a little jitter so several hubs don't knock at once
    this.timer = setTimeout(() => this.dial(), base * (0.8 + Math.random() * 0.4));
    this.timer.unref?.();
  }
}
