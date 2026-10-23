// Spots sessions that look stuck: busy for a long time without writing anything, calling the same tool over
// and over, or failing tool calls in a row. Checked once a minute. A nearly full context isn't one of them:
// Claude Code compacts it by itself.
import type { Entry, Session } from "@cockpit/shared";
import { listSessions, sessionFile } from "./claude/sessions.ts";
import { parseLine, readTail } from "./claude/transcript.ts";
import { emit } from "./events.ts";
import { notify } from "./notify.ts";
import { getSettings } from "./settings.ts";

const flags = new Map<string, string>();
const grew = new Map<string, { size: number; at: number }>();
const told = new Set<string>();

export const stuckReason = (s: Pick<Session, "id">) => flags.get(s.id);

// pure, so the rules can be tested on made-up transcripts
export function looksStuck(entries: Entry[]): string | undefined {
  const tools = entries.filter((e) => e.kind === "tool").slice(-8) as Extract<Entry, { kind: "tool" }>[];
  const counts = new Map<string, number>();
  for (const t of tools) {
    const k = `${t.name}:${JSON.stringify(t.input)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const [same, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (n >= 4) return `Called ${same.split(":")[0]} the same way ${n} times`;
  const results = entries.filter((e) => e.kind === "tool_result").slice(-10) as Extract<Entry, { kind: "tool_result" }>[];
  const errors = results.filter((r) => r.isError).length;
  if (errors >= 3 && results.slice(-3).every((r) => r.isError)) return `${errors} tool calls failed in a row`;
  return;
}

// one notification per kind of problem: "No progress for 21 minutes" and "...22 minutes" are the same one
export const alertKey = (id: string, reason: string) => `${id}:${reason.replace(/\d+/g, "#")}`;

async function check() {
  const minutes = getSettings().alerts.stuckMinutes;
  const now = Date.now();
  const live = listSessions({ liveOnly: true });
  for (const id of flags.keys()) if (!live.some((s) => s.id === id)) flags.delete(id);
  for (const s of live) {
    const g = grew.get(s.id);
    if (!g || g.size !== s.size) grew.set(s.id, { size: s.size, at: now });
    let reason: string | undefined;
    // a long background job writes nothing to the transcript, and that's fine
    if (s.status === "busy" && !s.background && g && g.size === s.size && now - g.at >= minutes * 60_000) reason = `No progress for ${Math.round((now - g.at) / 60_000)} minutes`;
    const file = sessionFile(s.id);
    if (!reason && file && s.status === "busy" && !s.background) {
      const tail = await readTail(file, 192 * 1024).catch(() => undefined);
      if (tail) reason = looksStuck(tail.lines.flatMap((l) => parseLine(l)));
    }
    if (reason) flags.set(s.id, reason);
    else if (flags.delete(s.id)) {
      // it recovered, so getting stuck again later is news again
      for (const k of told) if (k.startsWith(`${s.id}:`)) told.delete(k);
    }
    const key = reason && alertKey(s.id, reason);
    if (reason && key && !told.has(key)) {
      told.add(key);
      notify({ title: `${s.title ?? s.name ?? "A session"} looks stuck`, body: reason, link: `/sessions/${s.id}` });
      emit("session.stuck", { id: s.id, reason });
    }
  }
}

export function startStuckWatch() {
  setInterval(() => check().catch((e) => console.error("stuck check", e)), 60_000);
}
