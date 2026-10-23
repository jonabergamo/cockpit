// "Ask cockpit": a question about your own work, answered by `claude -p` from what cockpit already knows. The
// transcript search finds the sessions that talked about it; the Board, your tickets and recent sessions add the
// state of things. Claude only reads that context, it doesn't go looking, so answers are quick and stay local.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { board } from "./board.ts";
import { listSessions } from "./claude/sessions.ts";
import { searchSessions } from "./claude/search.ts";
import { config, paths } from "./config.ts";
import { startJob } from "./jobs.ts";
import { myTickets } from "./providers.ts";
import { day } from "./util.ts";

const MAX = 24_000;

// the words worth searching for: a question like "when did I fix the basket total?" searches "fix basket total"
export function searchTerms(question: string) {
  const stop = new Set("a an and are as at be by did do does for from had has have how i in is it its me my of on or our so that the this to was we what when where which who why will with you your".split(" "));
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 8);
}

export async function context(question: string) {
  const parts: string[] = [];
  const terms = searchTerms(question);
  // any word may match; the index ranks the sessions that match more of them first
  const hits = terms.length ? searchSessions(terms.join(" "), 10, true) : [];
  if (hits.length) {
    parts.push("## Sessions whose transcripts mention it");
    for (const h of hits) parts.push(`- [${h.title ?? h.id.slice(0, 8)}](/sessions/${h.id}) in ${h.cwd ?? "?"}, last ${h.lastTs ? day(h.lastTs) : "?"}\n${h.hits.map((x) => `  - ${x.role} on ${day(x.ts)}: ${x.snippet.replace(/\s+/g, " ")}`).join("\n")}`);
  }
  const cards = await board().catch(() => []);
  if (cards.length) {
    parts.push("## The Board now (what's in flight)");
    for (const c of cards.slice(0, 30)) parts.push(`- ${c.ticket ? `${c.ticket} ` : ""}${c.title}: ${c.column}, ${c.reason}${c.pr ? `, PR #${c.pr.number} ${c.pr.state.toLowerCase()}` : ""}${c.session ? ` ([session](/sessions/${c.session.id}))` : ""}`);
  }
  const tickets = await myTickets().catch(() => []);
  if (tickets.length) {
    parts.push("## My tickets");
    for (const t of tickets.slice(0, 50)) parts.push(`- [${t.key}](/tickets?key=${t.key}) ${t.summary} (${t.status}${t.inSprint ? ", this sprint" : ""})`);
  }
  parts.push("## Recent sessions");
  for (const s of listSessions({ limit: 40 })) parts.push(`- [${s.title ?? s.name ?? s.id.slice(0, 8)}](/sessions/${s.id})${s.ticket ? ` ${s.ticket}` : ""} in ${s.cwd}, ${s.status}, last ${day(s.updatedAt)}`);
  const text = parts.join("\n");
  return text.length > MAX ? `${text.slice(0, MAX)}\n…` : text;
}

export async function ask(question: string) {
  const prompt = `You answer a developer's question about their own work, using only cockpit's notes below: their Claude Code sessions, the work in flight and their tickets. Today is ${day(Date.now())}.

Answer in a few sentences or a short list. Link the sessions and tickets you rely on with the markdown links given in the notes, exactly as written. If the notes don't hold the answer, say so plainly and suggest where to look, rather than guessing. Don't use tools.

Question: ${question}

# Cockpit's notes
${await context(question)}`;
  // through a file, since the context is too long for an argument
  const file = join(paths.data, `ask-${Date.now()}.txt`);
  writeFileSync(file, prompt, { mode: 0o600 });
  const q = JSON.stringify(file);
  return startJob("ask cockpit", `claude -p --model sonnet < ${q}; code=$?; rm -f ${q}; exit $code`, config.repo.path || process.env.HOME);
}
