// The short things you keep typing to sessions ("open the PR", "go ahead"), read from what search already indexed,
// offered as chips by every reply box. Pinned ones come first and hidden ones never show (Settings → Automation).
import { createHash } from "node:crypto";
import { db } from "./db.ts";
import { quick } from "./quick.ts";
import { getSettings } from "./settings.ts";

export interface ReplyCount {
  text: string;
  count: number;
}
export interface ReplyChip extends ReplyCount {
  pinned?: boolean;
}

const MAX_LEN = 80;
const DAYS = 30;
// a node sends the hub more than it shows, so hidden ones and other machines' can still leave a full row
const KEEP = 40;
const SHOW = 8;

// trailing punctuation and spacing don't make a different reply
const tidy = (s: string) => s.trim().replace(/\s+/g, " ").replace(/[\s.!?,;:…]+$/u, "");
export const replyKey = (s: string) => tidy(s).toLowerCase();

// what isn't a reply you'd type again: commands, Claude Code's own markers, pasted links, paths and images, a menu's number
export function isReply(raw: string) {
  const s = raw.trim();
  if (s.length < 2 || s.length >= MAX_LEN || s.includes("\n")) return false;
  if (/^[/!<#[~]/.test(s)) return false;
  if (/https?:\/\/|\[(image|pasted)/i.test(s)) return false;
  if (/^\d+$/.test(tidy(s))) return false;
  return !!tidy(s);
}

// grouped by their key, each shown the way you wrote it most often
export function groupReplies(texts: string[]): ReplyCount[] {
  const by = new Map<string, { count: number; forms: Map<string, number> }>();
  for (const t of texts) {
    if (!isReply(t)) continue;
    const k = replyKey(t);
    const g = by.get(k) ?? { count: 0, forms: new Map() };
    g.count++;
    const form = tidy(t);
    g.forms.set(form, (g.forms.get(form) ?? 0) + 1);
    by.set(k, g);
  }
  return [...by.values()]
    .filter((g) => g.count >= 2)
    .map((g) => ({ text: [...g.forms].sort((a, b) => b[1] - a[1])[0][0], count: g.count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, KEEP);
}

// prepared when first asked, as search.ts makes the table
const recent = () => db.prepare<[number, string], { text: string }>("select text from session_text where role = 'user' and length(text) < ? and ts >= ?");
let here: { at: number; list: ReplyCount[] } | undefined;

// this machine's, kept a few minutes: it reads every short prompt of the last month
export function frequentHere(now = Date.now()): ReplyCount[] {
  if (here && now - here.at < 5 * 60_000) return here.list;
  const since = new Date(now - DAYS * 86_400_000).toISOString();
  here = { at: now, list: groupReplies(recent().all(MAX_LEN, since).map((r) => r.text)) };
  return here.list;
}
export const forgetFrequent = () => void (here = undefined);

// several machines' lists as one, then your pins first and your hidden ones out
export function chipsFrom(lists: ReplyCount[][], s = getSettings().replies): ReplyChip[] {
  const sum = new Map<string, ReplyCount>();
  for (const r of lists.flat()) {
    const k = replyKey(r.text);
    const g = sum.get(k);
    if (g) g.count += r.count;
    else sum.set(k, { ...r });
  }
  const hidden = new Set(s.hidden.map(replyKey));
  const pinned = s.pinned.filter((p) => !hidden.has(replyKey(p)));
  const pinKeys = new Set(pinned.map(replyKey));
  const rest = [...sum.values()].filter((r) => !hidden.has(replyKey(r.text)) && !pinKeys.has(replyKey(r.text))).sort((a, b) => b.count - a.count);
  return [...pinned.map((p) => ({ text: p, count: sum.get(replyKey(p))?.count ?? 0, pinned: true })), ...rest.slice(0, SHOW)];
}

// The model's best guess at which replies fit what the session last said, best first; undefined without a local
// model, which leaves them by how often you use them. Remembered, since the same question gets asked every poll.
const ranked = new Map<string, string[] | undefined>();
export async function rankReplies(last: string, texts: string[]): Promise<string[] | undefined> {
  if (!last.trim() || texts.length < 2) return;
  const key = createHash("sha1").update(JSON.stringify([last, texts])).digest("hex");
  if (ranked.has(key)) return ranked.get(key);
  const list = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const a = await quick(`A coding agent just said:\n"""\n${last.slice(-1500)}\n"""\n\nWhich of these replies fit best as the answer? Give their numbers, best first, comma separated, nothing else.\n${list}`, { max: 40, timeoutMs: 15_000 });
  const order = a ? parseOrder(a, texts) : undefined;
  if (ranked.size > 200) ranked.clear();
  ranked.set(key, order);
  return order;
}

// the numbers the model gave, then any it left out in their old order
export function parseOrder(answer: string, texts: string[]): string[] | undefined {
  const picked = [...new Set((answer.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 1 && n <= texts.length))];
  if (!picked.length) return;
  return [...picked.map((n) => texts[n - 1]), ...texts.filter((_, i) => !picked.includes(i + 1))];
}
