// Which tickets have no code to write (leave, on-call, a meeting), sorted by the local model once per ticket and
// kept, so a ticket worded differently from Settings' pattern still lands under Not code. Only ever adds to the
// pattern: without a model, or before a ticket is sorted, the pattern alone decides as before.
import type { Ticket } from "@cockpit/shared";
import { boardChanged } from "./board.ts";
import { db } from "./db.ts";
import { quick, quickOn } from "./quick.ts";

db.exec("create table if not exists ticket_kinds (key text primary key, summary text not null, code integer not null, at integer not null)");
const get = db.prepare<[string], { summary: string; code: number }>("select summary, code from ticket_kinds where key = ?");
const put = db.prepare("insert or replace into ticket_kinds (key, summary, code, at) values (?, ?, ?, ?)");

// the tickets sorted as no code; the rest are sorted in the background and show on the next load
export function noCodeKeys(tickets: Pick<Ticket, "key" | "summary" | "type">[]): Set<string> {
  const out = new Set<string>();
  if (!quickOn()) return out;
  const todo: typeof tickets = [];
  for (const t of tickets) {
    const row = get.get(t.key);
    // sorted again when its summary changes
    if (row && row.summary === t.summary) {
      if (!row.code) out.add(t.key);
    } else todo.push(t);
  }
  if (todo.length) void sortTickets(todo);
  return out;
}

let sorting = false;
async function sortTickets(list: Pick<Ticket, "key" | "summary" | "type">[]) {
  if (sorting) return;
  sorting = true;
  let changed = false;
  try {
    for (const t of list) {
      const a = await quick(`A ticket on a software team's board is titled: "${t.summary}"${t.type ? ` (a ${t.type})` : ""}.\nDoes doing it mean changing code? Answer with one word, code or nocode.`, { max: 4 });
      const word = a?.toLowerCase().replace(/[^a-z]/g, "");
      // no answer (no model, Ollama down) leaves the rest for the next load
      if (!word) break;
      const code = word.startsWith("nocode") ? 0 : word.startsWith("code") ? 1 : undefined;
      if (code === undefined) continue;
      put.run(t.key, t.summary, code, Date.now());
      if (!code) changed = true;
    }
  } finally {
    sorting = false;
  }
  if (changed) boardChanged();
}
