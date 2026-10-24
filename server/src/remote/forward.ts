// The hub's screens for what runs on a node: tasks, the overnight queue, runs, verify, autopilot, previews, CI
// comparisons, stacked work, budgets. Those live on the node, which keeps doing them while the hub sleeps, so
// the hub sends the request itself over the link and the node answers it with its own API, as if a browser had
// asked it. Anything that changes something carries an id; when the link drops before the answer comes back the
// hub asks again with the same id, and the node answers from what it already did instead of doing it twice.
import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import type { BoardCard, ServerEvent } from "@cockpit/shared";
import { useRemoteBoards } from "../board.ts";
import { config } from "../config.ts";
import { broadcast } from "../hub.ts";
import { getRun } from "../runs.ts";
import type { RemoteLink } from "./link.ts";
import { findOwner } from "./work.ts";
import { pluginOn, where } from "../placement/where.ts";

export interface ApiReq {
  op: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ApiRes {
  status: number;
  headers: Record<string, string>;
  // text as it is, anything else base64
  body: string;
  base64?: boolean;
}

const PASS = ["content-type", "content-range", "accept-ranges", "content-length", "content-disposition"];
// a video asked for from its start to its end comes in slices this big, which the browser asks for in turn
const SLICE = 4 * 1024 * 1024;

// ---- the node's side: answer with this machine's own API, once per id

let fetchApi: ((req: Request) => Response | Promise<Response>) | undefined;
export const serveApi = (fn: (req: Request) => Response | Promise<Response>) => void (fetchApi = fn);

const done = new Map<string, { at: number; res: Promise<ApiRes> }>();
const KEEP_MS = 10 * 60_000;

async function answer(r: ApiReq): Promise<ApiRes> {
  if (!fetchApi) throw new Error("this node can't answer API requests yet");
  const res = await fetchApi(new Request(`http://node${r.path}`, { method: r.method, headers: r.headers, body: r.body }));
  const headers = Object.fromEntries(PASS.flatMap((h) => (res.headers.get(h) ? [[h, res.headers.get(h)!]] : [])));
  const buf = Buffer.from(await res.arrayBuffer());
  const text = /^(text\/|application\/json)/.test(headers["content-type"] ?? "text/");
  return { status: res.status, headers, body: text ? buf.toString("utf8") : buf.toString("base64"), base64: !text };
}

export function handleApi(r: ApiReq) {
  if (r.method === "GET") return answer(r);
  const now = Date.now();
  for (const [op, d] of done) if (now - d.at > KEEP_MS) done.delete(op);
  const seen = done.get(r.op);
  if (seen) return seen.res;
  const res = answer(r);
  done.set(r.op, { at: now, res });
  return res;
}

// ---- the hub's side

const links = new Map<string, RemoteLink>();
export function addApiLink(machine: string, link: RemoteLink) {
  links.set(machine, link);
  // what the node's own screens would hear about its board and runs, heard here instead
  link.onUp((c) => c.on("relay", (ev: ServerEvent) => broadcast(ev.type === "run" ? { ...ev, run: { ...ev.run, node: machine } } : ev)));
}
export const removeApiLink = (machine: string) => void links.delete(machine);

// the node that runs the automations, from Settings → Machines; undefined is this machine
export const automationsNode = () => {
  const m = where("automations");
  return m && links.has(m) ? m : undefined;
};

const waitUp = (link: RemoteLink, ms: number) =>
  new Promise<boolean>((ok) => {
    if (link.status.state === "up") return ok(true);
    let off = () => {};
    const t = setTimeout(() => (off(), ok(false)), ms);
    off = link.onUp(() => (clearTimeout(t), off(), ok(true)));
  });

export async function requestApi(machine: string, r: Omit<ApiReq, "op">, timeoutMs = 30_000): Promise<ApiRes> {
  const link = links.get(machine);
  if (!link) throw Object.assign(new Error(`No machine called ${machine}`), { status: 404 });
  const req: ApiReq = { ...r, op: randomUUID() };
  for (let attempt = 0; ; attempt++) {
    try {
      return await link.request<ApiRes>("api", req, timeoutMs);
    } catch (e) {
      // only a dropped link is worth asking again for, and only while it comes back soon
      const down = (e as { status?: number }).status === 503;
      if (!down || attempt >= 2 || !(await waitUp(link, 20_000))) throw e;
    }
  }
}

const toResponse = (r: ApiRes) => new Response(r.base64 ? Buffer.from(r.body, "base64") : r.body, { status: r.status, headers: r.headers });

const worktreeOf = async (c: Context) => {
  const q = c.req.query("worktree") ?? c.req.query("path");
  if (q) return q;
  if (c.req.method === "GET") return "";
  const b = (await c.req.raw.clone().json().catch(() => ({}))) as { worktree?: string; path?: string; id?: string };
  return b.worktree ?? b.path ?? b.id ?? "";
};

// Which machine answers a request: this one, or a node. Only a hub hands work out; a single machine does it all.
async function target(c: Context, path: string): Promise<string | undefined> {
  // a plugin put on a node answers its own routes there
  const plugin = path.match(/^\/plugins\/([\w-]+)\/x(\/|$)/)?.[1];
  if (plugin) {
    const on = pluginOn(plugin);
    return on && links.has(on) ? on : undefined;
  }
  const auto = automationsNode();
  if (config.role !== "hub" || !auto) return;
  // the hooks and `cockpit run` of this machine record its own runs
  if (path.startsWith("/runs/hook") || (path === "/runs" && c.req.method === "POST")) return;
  if (path.startsWith("/tasks") || path.startsWith("/budgets")) return auto;
  if (path.startsWith("/runs/options")) return await findOwner(await worktreeOf(c));
  const run = path.match(/^\/runs\/([^/]+)/)?.[1];
  if (run) return getRun(run) ? undefined : auto;
  if (/^\/(autopilot|verify|preview|ci\/compare|stacked|board\/archive)/.test(path)) return await findOwner(await worktreeOf(c));
}

export async function forward(c: Context, next: Next) {
  const path = c.req.path.replace(/^\/api/, "");
  const node = await target(c, path);
  if (!node) return next();
  const headers: Record<string, string> = {};
  const type = c.req.header("content-type");
  if (type) headers["content-type"] = type;
  const range = c.req.header("range")?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) headers.range = `bytes=${range[1]}-${range[2] || Number(range[1]) + SLICE - 1}`;
  const url = new URL(c.req.url);
  const body = ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.text();
  try {
    return toResponse(await requestApi(node, { method: c.req.method, path: path + url.search, headers, body }));
  } catch (e) {
    return c.json({ error: (e as Error).message }, ((e as { status?: number }).status ?? 502) as 502);
  }
}

// GET /runs here is this machine's runs and the automations node's, newest first
export async function runsEverywhere<T extends { startedAt: number }>(mine: T[], search: string, limit: number) {
  const node = config.role === "hub" ? automationsNode() : undefined;
  if (!node) return mine;
  const theirs = await requestApi(node, { method: "GET", path: `/runs${search}`, headers: {} })
    .then((r) => (r.status === 200 ? (JSON.parse(r.body) as T[]).map((x) => ({ ...x, node })) : []))
    .catch(() => [] as T[]);
  return [...mine, ...theirs].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

// every node's board, each card tagged; a node that's down shows nothing rather than stale cards
export function startRemoteBoards() {
  useRemoteBoards(async (offline) => {
    const up = [...links].filter(([, l]) => l.status.state === "up");
    const boards = await Promise.all(
      up.map(([node, link]) =>
        link
          .request<BoardCard[]>("board", { offline }, offline ? 5_000 : 30_000)
          .then((cards) => cards.map((c) => ({ ...c, node })))
          .catch(() => [] as BoardCard[]),
      ),
    );
    return boards.flat();
  });
}
