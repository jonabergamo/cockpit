// "While you were away" on the canvas: for each terminal on a workspace whose agent did something since you last
// looked, what it did (files it edited, commands it ran, commits it made) and what it last said. Read straight from
// the transcripts, so it works for anyone; with a local model set up, it also gets a line of summary.
import type { Entry, Session } from "@cockpit/shared";
import { tailEntries } from "./claude/entries.ts";
import { listSessions } from "./claude/sessions.ts";
import { quick } from "./quick.ts";
import { onNode } from "./remote/sessions.ts";

export interface AwayItem {
  term: string;
  session: string;
  title: string;
  status: Session["status"];
  edited: string[];
  commands: number;
  commits: string[];
  last?: string;
  summary?: string;
}

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// what a run of transcript entries since then adds up to
export function tally(entries: Entry[], since: number) {
  const after = entries.filter((e) => Date.parse(e.ts) > since);
  const edited = new Set<string>();
  const commits: string[] = [];
  let commands = 0;
  let last: string | undefined;
  for (const e of after) {
    if (e.kind === "tool") {
      const input = (e.input ?? {}) as Record<string, unknown>;
      if (EDITS.has(e.name) && typeof input.file_path === "string") edited.add(input.file_path);
      if (e.name === "Bash" && typeof input.command === "string") {
        commands++;
        const m = input.command.match(/git commit[^\n]*-m\s+(?:"([^"]+)"|'([^']+)')/);
        if (m) commits.push((m[1] ?? m[2]).split("\n")[0]);
      }
    }
    if (e.kind === "assistant" && e.text.trim()) last = e.text.trim();
  }
  return { any: after.length > 0, edited: [...edited], commands, commits, last };
}

// the first sentence or line of what it said last, short enough for one row
export const firstWords = (text?: string) => {
  if (!text) return;
  // headings say what's coming, not what happened: the first line of prose, or a heading when that's all there is
  const lines = text.split("\n").filter((l) => l.trim());
  const line = (lines.find((l) => !/^\s*#/.test(l)) ?? lines[0] ?? "").replace(/^\s*#+\s*/, "").trim();
  const sentence = line.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? line;
  return sentence.length > 200 ? `${sentence.slice(0, 200)}…` : sentence;
};

const entriesOf = (s: Session) => onNode(s.id, (n) => n.request<{ entries: Entry[] } | undefined>("session.entries", { id: s.id, bytes: 2 * 1024 * 1024 }), () => tailEntries(s.id, undefined, 2 * 1024 * 1024));

export async function away(terms: string[], since: number): Promise<AwayItem[]> {
  const wanted = new Set(terms);
  const sessions = listSessions({ limit: 500 }).filter((s) => s.term && wanted.has(s.term) && s.updatedAt > since);
  const items = await Promise.all(
    sessions.map(async (s): Promise<AwayItem | undefined> => {
      const got = await entriesOf(s).catch(() => undefined);
      const t = tally(got?.entries ?? [], since);
      if (!t.any) return;
      const item: AwayItem = { term: s.term!, session: s.id, title: s.title || s.name || "Session", status: s.status, edited: t.edited, commands: t.commands, commits: t.commits, last: firstWords(t.last) };
      if (t.last) item.summary = (await quick(`In one short sentence, say what this coding agent did and where it stands, for someone who was away. Reply with the sentence only.\n\n${t.last.slice(0, 3000)}`, { max: 60, timeoutMs: 8000 }))?.split("\n")[0];
      return item;
    }),
  );
  return items.filter((i): i is AwayItem => !!i);
}
