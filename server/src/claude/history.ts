import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";

export interface HistoryItem {
  text: string;
  ts: number;
  project: string;
  sessionId?: string;
}

export async function searchHistory(q: string, limit: number) {
  const raw = await readFile(join(config.claude.dir, "history.jsonl"), "utf8").catch(() => "");
  const needle = q.toLowerCase();
  const out: HistoryItem[] = [];
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    try {
      const d = JSON.parse(lines[i]);
      if (needle && !String(d.display).toLowerCase().includes(needle)) continue;
      out.push({ text: d.display, ts: d.timestamp, project: d.project, sessionId: d.sessionId });
    } catch {}
  }
  return out;
}
