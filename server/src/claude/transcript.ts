import { open, stat } from "node:fs/promises";
import type { Entry } from "@cockpit/shared";

const NOISE = /^\{"type":"(api-request|api-request-blob|api-request-shape|file-history-snapshot|file-history-delta|atis-latch|mode|permission-mode|queue-operation|agent-name)"/;
const MAX_TEXT = 20_000;

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `\n… (${s.length - MAX_TEXT} more chars)` : s);

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

export interface Meta {
  title?: string;
  lastPrompt?: string;
  branch?: string;
  cwd?: string;
  costUSD?: number;
  linesAdded?: number;
  linesRemoved?: number;
  firstTs?: string;
  lastTs?: string;
}

// One JSONL line can produce several entries (assistant content blocks, multiple tool results).
export function parseLine(line: string, meta?: Meta): Entry[] {
  if (!line || NOISE.test(line)) return [];

  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return [];
  }

  if (meta) {
    if (d.type === "ai-title") meta.title = d.aiTitle;
    if (d.type === "last-prompt") meta.lastPrompt = d.lastPrompt;
    if (d.gitBranch && d.gitBranch !== "HEAD") meta.branch = d.gitBranch;
    if (d.cwd && !meta.cwd) meta.cwd = d.cwd;
    if (d.timestamp) {
      meta.firstTs ??= d.timestamp;
      meta.lastTs = d.timestamp;
    }
    if (d.type === "cost-state") {
      meta.costUSD = d.totalCostUSD;
      meta.linesAdded = d.totalLinesAdded;
      meta.linesRemoved = d.totalLinesRemoved;
    }
  }

  const id: string = d.uuid ?? "";
  const ts: string = d.timestamp ?? "";

  switch (d.type) {
    case "user": {
      const c = d.message?.content;
      if (d.isMeta) return [];
      if (typeof c === "string") {
        if (c.startsWith("<local-command") || c.startsWith("<command-")) return [{ kind: "system", id, ts, subtype: "command", text: c }];
        return [{ kind: "user", id, ts, text: clip(c) }];
      }
      if (!Array.isArray(c)) return [];
      const out: Entry[] = [];
      c.forEach((b, i) => {
        if (b.type === "tool_result") {
          out.push({ kind: "tool_result", id: `${id}:${i}`, ts, toolUseId: b.tool_use_id, text: clip(flatten(b.content)), isError: !!b.is_error });
        } else if (b.type === "text" && !b.text.startsWith("<system-reminder>")) {
          out.push({ kind: "user", id: `${id}:${i}`, ts, text: clip(b.text) });
        }
      });
      return out;
    }
    case "assistant": {
      const out: Entry[] = [];
      const model = d.message?.model;
      for (const [i, b] of (d.message?.content ?? []).entries()) {
        const bid = `${id}:${i}`;
        if (b.type === "text" && b.text) out.push({ kind: "assistant", id: bid, ts, text: clip(b.text), model });
        else if (b.type === "thinking" && b.thinking) out.push({ kind: "thinking", id: bid, ts, text: clip(b.thinking) });
        else if (b.type === "tool_use") out.push({ kind: "tool", id: bid, ts, toolUseId: b.id, name: b.name, input: b.input });
      }
      return out;
    }
    case "system": {
      if (d.subtype === "turn_duration") return [{ kind: "system", id, ts, subtype: "turn", text: `${Math.round(d.durationMs / 1000)}s` }];
      if (d.subtype === "away_summary") return [{ kind: "system", id, ts, subtype: "away", text: String(d.content ?? "") }];
      if (d.subtype === "local_command" || d.subtype === "compact_boundary") return [{ kind: "system", id, ts, subtype: d.subtype, text: String(d.content ?? "") }];
      return [];
    }
    case "cost-state":
      return [
        {
          kind: "cost",
          id: `cost:${d.totalDuration}`,
          ts: new Date().toISOString(),
          costUSD: d.totalCostUSD ?? 0,
          linesAdded: d.totalLinesAdded ?? 0,
          linesRemoved: d.totalLinesRemoved ?? 0,
          models: d.modelUsage ?? {},
        },
      ];
  }
  return [];
}

// Reads complete lines from `offset`. Returns the new offset, leaving any partial last line for next time.
export async function readFrom(file: string, offset: number, maxBytes = 8 * 1024 * 1024) {
  const { size } = await stat(file);
  if (size < offset) offset = 0;
  if (size === offset) return { lines: [] as string[], offset };

  const fh = await open(file, "r");
  try {
    const len = Math.min(size - offset, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    const lastNl = buf.lastIndexOf(10);
    if (lastNl === -1) return { lines: [], offset };
    const text = buf.subarray(0, lastNl).toString("utf8");
    return { lines: text.split("\n"), offset: offset + lastNl + 1 };
  } finally {
    await fh.close();
  }
}

// Reads the last `maxBytes` of a file, starting at a line boundary.
export async function readTail(file: string, maxBytes: number) {
  const { size } = await stat(file);
  const start = Math.max(0, size - maxBytes);
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const s = start > 0 ? buf.indexOf(10) + 1 : 0;
    const e = buf.lastIndexOf(10);
    if (e < s) return { lines: [] as string[], offset: start + s, truncated: start > 0 };
    return { lines: buf.subarray(s, e).toString("utf8").split("\n"), offset: start + e + 1, truncated: start > 0 };
  } finally {
    await fh.close();
  }
}
