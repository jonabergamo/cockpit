import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { codexHome } from "../codexUsage.ts";
import { config } from "../config.ts";
import { codexTerminalMeta } from "./codexTerminal.ts";

export interface HistoryItem {
  text: string;
  ts: number;
  project: string;
  sessionId?: string;
}

// Newest first, from Claude Code's history and Codex's (which keeps seconds and no folder)
export async function searchHistory(q: string, limit: number) {
  const needle = q.toLowerCase();
  const read = async (file: string, item: (d: any) => HistoryItem) => {
    const raw = await readFile(file, "utf8").catch(() => "");
    const out: HistoryItem[] = [];
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      try {
        const h = item(JSON.parse(lines[i]));
        if (needle && !String(h.text).toLowerCase().includes(needle)) continue;
        out.push(h);
      } catch {}
    }
    return out;
  };
  const [claude, codex] = await Promise.all([
    read(join(config.claude.dir, "history.jsonl"), (d) => ({ text: d.display, ts: d.timestamp, project: d.project, sessionId: d.sessionId })),
    read(join(codexHome(), "history.jsonl"), (d) => {
      // linked only while cockpit lists the session (the last week of them)
      const m = codexTerminalMeta(d.session_id);
      return { text: d.text, ts: d.ts * 1000, project: m?.cwd ?? "", sessionId: m ? d.session_id : undefined };
    }),
  ]);
  return [...claude, ...codex].sort((a, b) => b.ts - a.ts).slice(0, limit);
}
