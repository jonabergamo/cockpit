// What a node has to tell its hub, kept until the hub has it. A node writes notifications and the "while you
// were away" log here instead of showing them, since nobody looks at a node; the hub pulls from where it last
// got to whenever the link comes up or the node says there's more, applies each row once (the last seq it
// applied is stored in the same transaction as what it wrote), then tells the node it can let them go.
import { db } from "../db.ts";
import { readRow, writeRow } from "../settings.ts";
import type { RemoteLink } from "./link.ts";

db.exec(`
  create table if not exists outbox (
    seq integer primary key autoincrement,
    at integer not null,
    kind text not null,
    data text not null
  );
`);

export interface OutRow {
  seq: number;
  at: number;
  kind: "notify" | "log";
  data: any;
}

const KEEP_DAYS = 7;
const PAGE = 200;
const waiting = new Set<() => void>();

// a node's side: queue it, and nudge any hub that's connected
export function enqueue(kind: OutRow["kind"], data: unknown) {
  db.prepare("insert into outbox (at, kind, data) values (?, ?, ?)").run(Date.now(), kind, JSON.stringify(data));
  for (const fn of waiting) fn();
}

export const onEnqueue = (fn: () => void) => (waiting.add(fn), () => void waiting.delete(fn));

export function since(seq: number, limit = PAGE): OutRow[] {
  return db
    .prepare<[number, number], { seq: number; at: number; kind: OutRow["kind"]; data: string }>("select * from outbox where seq > ? order by seq limit ?")
    .all(seq, limit)
    .map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

// the hub has everything up to seq; a week's worth stays for a hub that never comes back for it
export function ack(seq: number) {
  db.prepare("delete from outbox where seq <= ? or at < ?").run(seq, Date.now() - KEEP_DAYS * 86400_000);
}

// The hub's side. Rows older than this when they arrive happened while the hub was away, and are summed up in
// one notification instead of each going off now.
const STALE_MS = 2 * 60_000;
const lastKey = (machine: string) => `outbox:${machine}`;
export const lastApplied = (machine: string) => readRow<number>(lastKey(machine)) ?? 0;

export interface Apply {
  notify: (n: { title: string; body: string; link: string; urgent?: boolean; kind?: string; node?: string }) => void;
  log: (kind: string, title: string, body?: string, link?: string, ref?: string, at?: number) => void;
}

// a row as a plugin may have sent it, with the parts every row needs filled in
const tidy = (d: any) => ({ ...d, title: String(d?.title ?? "") || "(untitled)", body: String(d?.body ?? ""), link: String(d?.link ?? "/"), kind: d?.kind ? String(d.kind) : undefined });

// one page applied in one transaction; returns the notifications that are due now and the ones that went stale
export function applyRows(machine: string, rows: OutRow[], apply: Apply, now = Date.now()) {
  const due: OutRow[] = [];
  const stale: OutRow[] = [];
  db.transaction(() => {
    let last = lastApplied(machine);
    for (const r of rows) {
      if (r.seq <= last) continue;
      last = r.seq;
      const d = tidy(r.data);
      if (r.kind === "log") apply.log(d.kind ?? "notify", d.title, d.body, d.link, r.data?.ref, r.at);
      else if (now - r.at > STALE_MS) {
        stale.push({ ...r, data: d });
        apply.log(d.kind ?? "notify", d.title, d.body, d.link, undefined, r.at);
      } else due.push({ ...r, data: d });
    }
    writeRow(lastKey(machine), last);
  })();
  return { due, stale };
}

export function addInboxLink(machine: string, link: RemoteLink, apply: Apply) {
  let pulling: Promise<void> | undefined;
  let again = false;
  const pull = async () => {
    if (pulling) return void (again = true);
    pulling = (async () => {
      const stale: OutRow[] = [];
      // a node whose outbox starts again (its data was reset) is read from its start
      const head = await link.request<number>("outbox.head").catch(() => undefined);
      if (head !== undefined && head < lastApplied(machine)) writeRow(lastKey(machine), 0);
      for (;;) {
        again = false;
        const rows = await link.request<OutRow[]>("outbox.since", { seq: lastApplied(machine) }).catch(() => [] as OutRow[]);
        if (!rows.length) break;
        const got = applyRows(machine, rows, apply);
        stale.push(...got.stale);
        for (const r of got.due) apply.notify({ ...r.data, node: machine });
        await link.request("outbox.ack", { seq: lastApplied(machine) }).catch(() => {});
        if (rows.length < PAGE && !again) break;
      }
      if (stale.length) {
        const titles = [...new Set(stale.map((r) => r.data.title as string))].slice(0, 3).join(", ");
        apply.notify({ title: `While you were away, on ${machine}`, body: `${stale.length} ${stale.length === 1 ? "thing" : "things"}: ${titles}${stale.length > 3 ? "…" : ""}`, link: "/", kind: "away" });
      }
    })()
      .catch((e) => console.error(`outbox from ${machine}:`, (e as Error).message))
      .finally(() => {
      pulling = undefined;
      if (again) void pull();
    });
    return pulling;
  };
  link.onUp((c) => {
    c.on("outbox", () => void pull());
    void pull();
  });
  return pull;
}

// the newest row this node has written, kept or not
export const head = () => (db.prepare("select seq from sqlite_sequence where name = 'outbox'").get() as { seq: number } | undefined)?.seq ?? 0;

// a machine that's removed starts from the beginning if it's added again
export const forgetInbox = (machine: string) => db.prepare("delete from settings where key = ?").run(lastKey(machine));
