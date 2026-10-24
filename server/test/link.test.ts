import { afterEach, describe, expect, it } from "vitest";
import { RemoteLink } from "../src/remote/link.ts";
import { accept, fromTailnet, pair, serve } from "../src/remote/node.ts";
import { Channel, LinkDown, type Wire } from "../src/remote/protocol.ts";

// two ends of an in-memory socket; freeze stops delivery the way a sleeping laptop does, drop closes both ends
function wirePair() {
  type End = { msg: ((d: string) => void)[]; close: ((c: number, w: string) => void)[] };
  const a: End = { msg: [], close: [] };
  const b: End = { msg: [], close: [] };
  let frozen = false;
  let open = true;
  const shut = (code: number, why: string) => {
    if (!open) return;
    open = false;
    setTimeout(() => [...a.close, ...b.close].forEach((fn) => fn(code, why)), 0);
  };
  const end = (me: End, other: End): Wire => ({
    send: (d) => void (open && !frozen && setTimeout(() => open && other.msg.forEach((fn) => fn(d)), 0)),
    close: (code = 1000, why = "") => shut(code, why),
    onMessage: (fn) => void me.msg.push(fn),
    onClose: (fn) => void me.close.push(fn),
  });
  return { hub: end(a, b), node: end(b, a), freeze: () => (frozen = true), drop: () => shut(1006, "") };
}

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const TOKEN = "t".repeat(43);
const links: RemoteLink[] = [];
afterEach(() => links.splice(0).forEach((l) => l.stop()));

// a hub link whose every dial reaches a fresh node end
function connect(o: { token?: string; hub?: string; deadMs?: number } = {}) {
  const pairs: ReturnType<typeof wirePair>[] = [];
  const link = new RemoteLink({
    url: "mem://node",
    token: o.token ?? TOKEN,
    hub: o.hub ?? "hub-test",
    heartbeatMs: 20,
    deadMs: o.deadMs ?? 120,
    maxBackoffMs: 50,
    dial: () => {
      const p = wirePair();
      pairs.push(p);
      accept(p.node, { heartbeatMs: 20, deadMs: o.deadMs ?? 120, onChannel: (c) => (serve(c), c.handle("echo", (a) => a)) });
      return p.hub;
    },
  });
  links.push(link);
  return { link: link.start(), pairs };
}

describe("link", () => {
  pair("hub-test", TOKEN, true);

  it("pairs, answers requests and reports the node", async () => {
    const { link } = connect();
    await until(() => link.status.state === "up");
    expect(link.status.node).toBeTruthy();
    expect(await link.request("echo", { n: 1 })).toEqual({ n: 1 });
    expect((await link.request<{ platform: string }>("info")).platform).toContain(process.platform);
    await expect(link.request("nope")).rejects.toThrow(/unknown request nope/);
  });

  it("refuses a wrong token and a hub it isn't paired with", async () => {
    const wrong = connect({ token: "x".repeat(43) });
    await until(() => wrong.link.status.state === "refused");
    expect(wrong.link.status.error).toMatch(/isn't paired|token is wrong/);
    const other = connect({ hub: "hub-other" });
    await until(() => other.link.status.state === "refused");
  });

  it("refuses something at the node's address that can't show it has the key", async () => {
    const link = new RemoteLink({
      url: "mem://node",
      token: TOKEN,
      hub: "hub-test",
      maxBackoffMs: 50,
      dial: () => {
        const p = wirePair();
        // says hello like a node and welcomes any hub, without knowing the key
        p.node.onMessage((raw) => JSON.parse(raw).t === "auth" && p.node.send(JSON.stringify({ t: "welcome", node: "devbox", info: {}, mac: "00".repeat(32) })));
        setTimeout(() => p.node.send(JSON.stringify({ t: "hello", node: "devbox", name: "devbox", nonce: "n", protocol: 2, version: "0" })), 0);
        return p.hub;
      },
    });
    links.push(link.start());
    await until(() => link.status.state === "refused");
    expect(link.status.error).toMatch(/isn't the node this hub paired with/);
  });

  it("dials once however often it's told to try again while dialing", async () => {
    let dials = 0;
    const link = new RemoteLink({
      url: "mem://node",
      token: TOKEN,
      hub: "hub-test",
      dial: () => (dials++, wirePair().hub),
    });
    links.push(link.start());
    link.retry();
    link.retry();
    await new Promise((r) => setTimeout(r, 30));
    expect(dials).toBe(1);
  });

  it("goes down when the link drops and comes back by itself", async () => {
    const { link, pairs } = connect();
    await until(() => link.status.state === "up");
    pairs[0].drop();
    await until(() => link.status.state !== "up");
    await expect(link.request("echo", 1)).rejects.toThrow();
    await until(() => link.status.state === "up");
    expect(pairs.length).toBeGreaterThan(1);
    expect(await link.request("echo", 2)).toBe(2);
  });

  it("notices a link that went silent, like a laptop that slept", async () => {
    const { link, pairs } = connect({ deadMs: 100 });
    await until(() => link.status.state === "up");
    pairs[0].freeze();
    await until(() => link.status.state !== "up", 2000);
    await until(() => link.status.state === "up", 3000);
  });
});

describe("channel", () => {
  it("fails pending requests with LinkDown when the link drops", async () => {
    const p = wirePair();
    const hub = new Channel(p.hub, { heartbeatMs: 1000 });
    new Channel(p.node, { heartbeatMs: 1000 }).handle("slow", () => new Promise((r) => setTimeout(r, 1000)));
    const req = hub.request("slow");
    p.drop();
    await expect(req).rejects.toBeInstanceOf(LinkDown);
    hub.kill("done");
  });

  it("times a request out", async () => {
    const p = wirePair();
    const hub = new Channel(p.hub, { heartbeatMs: 1000 });
    new Channel(p.node, { heartbeatMs: 1000 }).handle("never", () => new Promise(() => {}));
    await expect(hub.request("never", undefined, 30)).rejects.toThrow(/too long/);
    hub.kill("done");
  });
});

it("lets in only this machine and Tailscale addresses", () => {
  expect(fromTailnet("127.0.0.1")).toBe(true);
  expect(fromTailnet("::ffff:100.101.5.7")).toBe(true);
  expect(fromTailnet("100.63.0.1")).toBe(false);
  expect(fromTailnet("192.168.1.4")).toBe(false);
});
