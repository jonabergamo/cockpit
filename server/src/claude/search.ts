import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Entry } from "@cockpit/shared";
import { db } from "../db.ts";
import { codexEntries, codexTerminalFiles, codexTerminalMeta } from "./codexTerminal.ts";
import { projectsDir } from "./sessions.ts";
import { parseLine, readFrom } from "./transcript.ts";

// What was said in every session, prompts and answers, for full-text search. Kept apart from the session
// index and filled incrementally by byte offset, so the first backfill can take its time in the background.
db.exec(`
  create virtual table if not exists session_text using fts5(
    text, session_id unindexed, entry_id unindexed, ts unindexed, role unindexed,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  create table if not exists search_files (file text primary key, offset integer not null, size integer not null);
`);

const getFile = db.prepare<[string], { offset: number; size: number }>("select offset, size from search_files where file = ?");
const putFile = db.prepare("insert or replace into search_files (file, offset, size) values (?, ?, ?)");
const putText = db.prepare("insert into session_text (text, session_id, entry_id, ts, role) values (?, ?, ?, ?, ?)");
const dropSession = db.prepare("delete from session_text where session_id = ?");

async function indexOne(file: string, id: string, parse: (line: string) => Entry[] = parseLine) {
  const { size } = await stat(file);
  const prev = getFile.get(file);
  if (prev && prev.size === size) return;
  let offset = prev && prev.offset <= size ? prev.offset : 0;
  if (offset === 0) dropSession.run(id);
  while (offset < size) {
    const chunk = await readFrom(file, offset);
    if (chunk.offset === offset) break;
    db.transaction(() => {
      for (const line of chunk.lines) {
        // cheap check before parsing: only prompts and answers are worth searching
        if (parse === parseLine ? !line.includes('"type":"user"') && !line.includes('"type":"assistant"') : !line.includes('"type":"message"')) continue;
        for (const e of parse(line)) {
          if ((e.kind === "user" || e.kind === "assistant") && e.text.trim()) putText.run(e.text.slice(0, 8000), id, e.id, e.ts, e.kind);
        }
      }
    })();
    offset = chunk.offset;
  }
  putFile.run(file, offset, size);
}

let running: Promise<void> | null = null;

export function indexSearch() {
  running ??= (async () => {
    for (const d of await readdir(projectsDir, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue;
      for (const f of await readdir(join(projectsDir, d.name)).catch(() => [] as string[])) {
        if (f.endsWith(".jsonl")) await indexOne(join(projectsDir, d.name, f), f.slice(0, -6)).catch(() => {});
      }
    }
    // and Codex's, the ones in a terminal
    for (const c of codexTerminalFiles()) await indexOne(c.file, c.id, codexEntries).catch(() => {});
  })().finally(() => (running = null));
  return running;
}

export function startSearch() {
  setTimeout(() => indexSearch().then(() => console.log("search indexed")), 30_000);
  setInterval(() => indexSearch().catch(() => {}), 60_000);
}

// Every word must appear; the last one may be the start of a word, so results show up while typing.
// every word by default; any of them for a question, where the best matches still rank first
export function toMatch(q: string, any = false) {
  const words = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(any ? " OR " : " ");
}

const find = db.prepare<[string, number], { session_id: string; entry_id: string; ts: string; role: string; snip: string }>(`
  select session_id, entry_id, ts, role, snippet(session_text, 0, '[[', ']]', '…', 14) snip
  from session_text where session_text match ? order by rank limit ?
`);
const meta = db.prepare<[string], { title: string | null; cwd: string | null; last_ts: string | null }>("select title, cwd, last_ts from sessions where id = ?");

// Best matches grouped by session, a few snippets each.
export function searchSessions(q: string, limit = 20, any = false) {
  const match = toMatch(q, any);
  if (!match) return [];
  const by = new Map<string, { id: string; title: string | null; cwd: string | null; lastTs: string | null; agent?: string; hits: { entryId: string; ts: string; role: string; snippet: string }[] }>();
  for (const r of find.all(match, 200)) {
    let s = by.get(r.session_id);
    if (!s) {
      if (by.size >= limit) continue;
      const claude = meta.get(r.session_id);
      const m = claude ?? codexTerminalMeta(r.session_id);
      s = { id: r.session_id, title: m?.title ?? null, cwd: m?.cwd ?? null, lastTs: m?.last_ts ?? null, agent: claude ? "Claude" : "Codex", hits: [] };
      by.set(r.session_id, s);
    }
    if (s.hits.length < 3) s.hits.push({ entryId: r.entry_id, ts: r.ts, role: r.role, snippet: r.snip });
  }
  return [...by.values()];
}
