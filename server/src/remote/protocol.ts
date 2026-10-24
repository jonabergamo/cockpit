// The link between a hub and a node: one WebSocket carrying requests with answers, events, and a heartbeat that
// notices a dead link (a laptop that slept, a dropped network) within seconds instead of waiting on TCP.
// Written against a small Wire so tests can run both ends in memory.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// both ends must speak the same major version; a mismatch is refused with a clear message instead of misbehaving
export const PROTOCOL = 1;

export interface Wire {
  send(data: string): void;
  close(code?: number, why?: string): void;
  onMessage(fn: (data: string) => void): void;
  onClose(fn: (code: number, why: string) => void): void;
}

export type Frame =
  | { t: "hello"; node: string; name: string; nonce: string; protocol: number; version: string }
  | { t: "auth"; hub: string; mac: string; protocol: number }
  | { t: "welcome"; node: string; info: NodeInfo }
  | { t: "refuse"; why: string }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number }
  | { t: "req"; id: number; m: string; a?: unknown }
  | { t: "res"; id: number; ok: boolean; v?: unknown; err?: string; status?: number }
  | { t: "ev"; name: string; data?: unknown };

// what a node says about itself when the link opens
export interface NodeInfo {
  hostname: string;
  platform: string;
  version: string;
  terminals: number;
  // an NVIDIA GPU, which makes Whisper much faster
  gpu?: boolean;
}

export class LinkDown extends Error {
  status = 503;
  constructor(what = "the link") {
    super(`${what} is down`);
  }
}

// pairing: the hub keeps the token, the node only its hash, and the handshake proves the hub has the token
// without sending it: the node picks a nonce and the hub answers with an HMAC keyed by the token's hash
export const keyOf = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export const newNonce = () => randomBytes(16).toString("hex");
export const macOf = (key: string, nonce: string, hub: string) => createHmac("sha256", key).update(`${nonce}|${hub}`).digest("hex");
export function macOk(key: string, nonce: string, hub: string, mac: string) {
  const want = Buffer.from(macOf(key, nonce, hub), "hex");
  const got = Buffer.from(mac, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

type Handler = (a: any) => unknown | Promise<unknown>;

// Requests, answers, events and the heartbeat over a Wire that has already been through the handshake
export class Channel {
  private next = 1;
  private pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
  private handlers = new Map<string, Handler>();
  private listeners = new Map<string, Set<(d: any) => void>>();
  private heard = Date.now();
  private beat?: NodeJS.Timeout;
  private closed = false;
  private closers = new Set<(why: string) => void>();
  rtt?: number;

  constructor(
    private wire: Wire,
    private opts: { heartbeatMs?: number; deadMs?: number; timeoutMs?: number } = {},
  ) {
    wire.onMessage((raw) => this.receive(raw));
    wire.onClose((_code, why) => this.down(why || "closed"));
    const every = opts.heartbeatMs ?? 10_000;
    this.beat = setInterval(() => {
      if (Date.now() - this.heard > (opts.deadMs ?? 25_000)) return this.kill("no answer");
      this.raw({ t: "ping", ts: Date.now() });
    }, every);
    this.beat.unref?.();
  }

  get up() {
    return !this.closed;
  }

  request<T = unknown>(m: string, a?: unknown, timeoutMs = this.opts.timeoutMs ?? 10_000): Promise<T> {
    if (this.closed) return Promise.reject(new LinkDown());
    const id = this.next++;
    return new Promise<T>((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(Object.assign(new Error(`${m} took too long to answer`), { status: 504 }));
      }, timeoutMs);
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail, timer });
      this.raw({ t: "req", id, m, a });
    });
  }

  handle(m: string, fn: Handler) {
    this.handlers.set(m, fn);
  }

  emit(name: string, data?: unknown) {
    if (!this.closed) this.raw({ t: "ev", name, data });
  }

  on(name: string, fn: (d: any) => void) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn);
    this.listeners.set(name, set);
    return () => void set.delete(fn);
  }

  onClose(fn: (why: string) => void) {
    this.closers.add(fn);
    return () => void this.closers.delete(fn);
  }

  // closes it now: the heartbeat found it dead, or this machine woke from sleep and knows it is
  kill(why: string) {
    if (this.closed) return;
    try {
      this.wire.close(4000, why);
    } catch {}
    this.down(why);
  }

  private raw(f: Frame) {
    try {
      this.wire.send(JSON.stringify(f));
    } catch {
      this.down("send failed");
    }
  }

  private down(why: string) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.beat);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.fail(new LinkDown());
    }
    this.pending.clear();
    for (const fn of this.closers) fn(why);
  }

  private receive(raw: string) {
    this.heard = Date.now();
    let f: Frame;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    if (f.t === "ping") return this.raw({ t: "pong", ts: f.ts });
    if (f.t === "pong") return void (this.rtt = Date.now() - f.ts);
    if (f.t === "res") {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      clearTimeout(p.timer);
      // a status the node gave the error carries over, so a 400 there is a 400 here
      return f.ok ? p.ok(f.v) : p.fail(Object.assign(new Error(f.err ?? "failed"), f.status ? { status: f.status } : {}));
    }
    if (f.t === "req") {
      const h = this.handlers.get(f.m);
      if (!h) return this.raw({ t: "res", id: f.id, ok: false, err: `unknown request ${f.m}` });
      Promise.resolve()
        .then(() => h(f.a))
        .then(
          (v) => this.raw({ t: "res", id: f.id, ok: true, v }),
          (e: Error & { status?: number }) => this.raw({ t: "res", id: f.id, ok: false, err: e?.message ?? String(e), status: e?.status }),
        );
      return;
    }
    if (f.t === "ev") for (const fn of this.listeners.get(f.name) ?? []) fn(f.data);
  }
}
