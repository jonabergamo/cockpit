// A session's transcript as entries: the end of it for opening a session, and what came after an offset for
// following it live. A node answers both for its own sessions, so the hub reads them the same way.
import { agentFile, sessionFile } from "./sessions.ts";
import { parseLine, readFrom, readTail } from "./transcript.ts";

const fileOf = async (id: string, agent?: string) => (agent ? await agentFile(id, agent) : sessionFile(id));

export async function tailEntries(id: string, agent?: string, bytes = 3 * 1024 * 1024) {
  const file = await fileOf(id, agent);
  if (!file) return;
  const tail = await readTail(file, Math.min(bytes, 64 * 1024 * 1024));
  return { entries: tail.lines.flatMap((l) => parseLine(l)), offset: tail.offset, truncated: tail.truncated };
}

export async function entriesSince(id: string, agent: string | undefined, offset: number) {
  const file = await fileOf(id, agent);
  if (!file) return;
  const chunk = await readFrom(file, offset);
  return { offset: chunk.offset, entries: chunk.lines.flatMap((l) => parseLine(l)) };
}
