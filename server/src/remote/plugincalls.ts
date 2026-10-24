// A plugin calling itself on another machine: k.expose there, k.remote(machine).call here. Files go first, as
// paths on this machine that the node keeps a copy of under its data folder. A file that only grew since the
// last call (a recording, say) sends just the new bytes; one that changed in place starts over, which the node
// finds by comparing the bytes just before where the copy ends.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, truncateSync, appendFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { paths } from "../config.ts";
import { requestWork } from "./work.ts";

const CHUNK = 4 * 1024 * 1024;
const TAIL = 64 * 1024;
const KEEP_DAYS = 7;

function readAt(file: string, start: number, length: number) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const tailOf = (file: string, end: number) => createHash("sha1").update(readAt(file, Math.max(0, end - TAIL), Math.min(TAIL, end))).digest("hex");

// ---- the calling machine

const sent = new Map<string, number>();

async function sendFile(machine: string, plugin: string, path: string) {
  const key = createHash("sha1").update(path).digest("hex").slice(0, 16) + (extname(path).match(/^\.\w{1,8}$/)?.[0] ?? "");
  const size = statSync(path).size;
  const seen = `${machine}\0${plugin}\0${path}`;
  let offset = Math.min(sent.get(seen) ?? 0, size);
  do {
    const data = readAt(path, offset, Math.min(CHUNK, size - offset));
    const { have } = await requestWork<{ have: number }>(machine, "plugin.file", { plugin, key, offset, tail: offset ? tailOf(path, offset) : "", data: data.toString("base64") }, 120_000);
    // the node says where its copy ends: further on, or back at the start when it didn't match
    offset = have;
  } while (offset < size);
  sent.set(seen, size);
  return key;
}

export async function callOn<T>(machine: string, plugin: string, name: string, args: unknown, opts: { files?: Record<string, string>; timeoutMs?: number } = {}) {
  const files: Record<string, string> = {};
  for (const [k, path] of Object.entries(opts.files ?? {})) {
    if (!existsSync(path)) throw Object.assign(new Error(`${path} doesn't exist`), { status: 400 });
    files[k] = await sendFile(machine, plugin, path);
  }
  return requestWork<T>(machine, "plugin.call", { plugin, name, args, files }, opts.timeoutMs ?? 60_000);
}

// ---- the machine being called

const dirOf = (plugin: string) => join(paths.data, "remote-files", plugin);

export function fileOf(plugin: string, key: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin) || !/^[0-9a-f]{16}(\.\w{1,8})?$/.test(key)) throw Object.assign(new Error("not a plugin file"), { status: 400 });
  return join(dirOf(plugin), key);
}

export function receiveFile({ plugin, key, offset, tail, data }: { plugin: string; key: string; offset: number; tail: string; data: string }) {
  const file = fileOf(plugin, key);
  mkdirSync(dirOf(plugin), { recursive: true });
  const have = existsSync(file) ? statSync(file).size : 0;
  if (offset > 0) {
    // the copy has to end exactly where the caller thinks, with the same bytes before it
    if (have < offset || tailOf(file, offset) !== tail) {
      if (existsSync(file)) truncateSync(file, 0);
      return { have: 0 };
    }
    if (have > offset) truncateSync(file, offset);
    appendFileSync(file, Buffer.from(data, "base64"));
  } else {
    writeFileSync(file, Buffer.from(data, "base64"));
    prune(plugin);
  }
  return { have: statSync(file).size };
}

function prune(plugin: string) {
  const old = Date.now() - KEEP_DAYS * 86400_000;
  for (const f of readdirSync(dirOf(plugin))) {
    const p = join(dirOf(plugin), f);
    if (statSync(p).mtimeMs < old) rmSync(p, { force: true });
  }
}
