// The nodes a hub works with: added in Settings with a name and an address, each with a pairing token the node
// learns once with `cockpit node pair`. Every one gets a link that keeps dialing until it's removed.
import type { Machine } from "@cockpit/shared";
import { randomBytes } from "node:crypto";
import { db } from "../db.ts";
import { broadcast } from "../hub.ts";
import { readRow, writeRow } from "../settings.ts";
import { slugify } from "../util.ts";
import { RemoteLink } from "./link.ts";
import { newToken } from "./protocol.ts";
import { addSessionLink, removeSessionLink } from "./sessions.ts";
import { addLink, startRemoteTerms, unlinked } from "./terminals.ts";

db.exec(`
  create table if not exists machines (
    id text primary key,
    name text not null,
    url text not null,
    token text not null,
    added_at integer not null
  );
`);

interface Row {
  id: string;
  name: string;
  url: string;
  token: string;
  added_at: number;
}

const links = new Map<string, { row: Row; link: RemoteLink }>();

// this hub's own id, which nodes are paired with; made once
export function hubId() {
  let id = readRow<string>("hubId");
  if (!id) writeRow("hubId", (id = `hub-${randomBytes(6).toString("hex")}`));
  return id;
}

const view = ({ row, link }: { row: Row; link: RemoteLink }): Machine => ({ id: row.id, name: row.name, url: row.url, ...link.status });
export const listMachines = () => [...links.values()].map(view);
export const linkOf = (id: string) => links.get(id)?.link;
const announce = () => broadcast({ type: "machines", machines: listMachines() });

// ws://host:8771/node from whatever was typed: a bare name, host:port, or a full URL
export function nodeUrl(input: string) {
  const s = input.trim().replace(/\/+$/, "");
  if (!s) throw Object.assign(new Error("Give the node's address, like devbox or devbox.tailnet.ts.net"), { status: 400 });
  if (/^wss?:\/\//.test(s)) return /\/node$/.test(s) ? s : `${s}/node`;
  if (/^https?:\/\//.test(s)) return `${s.replace(/^http/, "ws")}/node`;
  if (!/^[\w.-]+(:\d+)?$/.test(s)) throw Object.assign(new Error("That isn't an address"), { status: 400 });
  return `ws://${s.includes(":") ? s : `${s}:8771`}/node`;
}

function open(row: Row) {
  const link = new RemoteLink({ url: row.url, token: row.token, hub: hubId() });
  link.onStatus(announce);
  links.set(row.id, { row, link });
  addLink(row.id, link);
  addSessionLink(row.id, link);
  link.start();
}

export function addMachine(name: string, address: string) {
  const id = slugify(name, 24);
  if (!id) throw Object.assign(new Error("Give the machine a name"), { status: 400 });
  if (links.has(id)) throw Object.assign(new Error(`There's a machine called ${id} already`), { status: 409 });
  const row: Row = { id, name: name.trim(), url: nodeUrl(address), token: newToken(), added_at: Date.now() };
  db.prepare("insert into machines (id, name, url, token, added_at) values (@id, @name, @url, @token, @added_at)").run(row);
  open(row);
  announce();
  return { machine: view(links.get(id)!), pair: pairCommand(row) };
}

// what to run on the node; shown once when it's added and again on request
export const pairCommand = (row: Pick<Row, "token">) => `cockpit node pair --hub ${hubId()} --token ${row.token}`;
export function pairCommandOf(id: string) {
  const l = links.get(id);
  if (!l) throw Object.assign(new Error("No such machine"), { status: 404 });
  return pairCommand(l.row);
}

export function removeMachine(id: string) {
  const l = links.get(id);
  if (!l) throw Object.assign(new Error("No such machine"), { status: 404 });
  l.link.stop();
  links.delete(id);
  unlinked(id);
  removeSessionLink(id);
  db.prepare("delete from machines where id = ?").run(id);
  announce();
}

export const retryMachine = (id: string) => linkOf(id)?.retry();

export function startMachines() {
  startRemoteTerms([]);
  for (const row of db.prepare<[], Row>("select * from machines order by added_at").all()) open(row);
}
