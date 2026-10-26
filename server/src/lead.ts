// The lead: one Claude session per repo that plans with you and runs the work through cockpit's workers, and one
// more per epic you lead on its own. Each one's terminal and session are remembered, so the button goes back to
// the running one, or resumes the conversation when the terminal has gone.
import { existsSync } from "node:fs";
import type { Session } from "@cockpit/shared";
import { getSession, listSessions } from "./claude/sessions.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { onEvent } from "./events.ts";
import { listTerms, spawnTerm } from "./pty.ts";
import { agentLaunch } from "./workers/index.ts";
import { readRow, writeRow } from "./settings.ts";

interface Lead {
  term?: string;
  session?: string;
}

export interface EpicRef {
  key: string;
  summary?: string;
  url?: string;
}

const rowKey = (epic?: string) => `lead:${config.repo.path}${epic ? `:${epic}` : ""}`;
const SYSTEM =
  "You are the lead for this repository in cockpit. Use the cockpit-lead skill and the cockpit MCP tools (list_workers, start_task, read_screen, send_message, answer_prompt, pr_status) to plan with the user and run the work through workers. Start by asking what we're working on, unless they already said.";

// the session running in the lead's terminal, once it shows up
const runsIn = (s: Pick<Session, "term" | "pid">, term: { id: string; pid?: number }) => s.term === term.id || (!!term.pid && s.pid === term.pid);

// an epic's lead starts on the epic rather than asking what we're doing
const epicPrompt = (e: EpicRef) =>
  `Lead the epic ${e.key}${e.summary ? ` (${e.summary})` : ""}${e.url ? `: ${e.url}` : ""}. Read it and its child tickets from the tracker, check which already have workers, PRs or merged work with list_workers and pr_status, then propose a plan for the rest in waves. Don't start any task until I agree.`;

export function openLead(epic?: EpicRef) {
  if (!config.repo.path || !existsSync(config.repo.path)) throw Object.assign(new Error("Set repo.path in config.local.toml first"), { status: 400 });
  const key = rowKey(epic?.key);
  const saved = readRow<Lead>(key) ?? {};
  const term = saved.term && listTerms().find((t) => t.id === saved.term && t.exited === undefined);
  if (term) {
    const live = listSessions({ liveOnly: true }).find((s) => runsIn(s, term));
    if (live && live.id !== saved.session) writeRow(key, { ...saved, session: live.id });
    return term;
  }
  const resume = saved.session && getSession(saved.session) ? ["--resume", saved.session] : [];
  const first = !resume.length && epic ? [epicPrompt(epic)] : [];
  // another main agent has no system prompt to add to, so what the lead is goes first in its prompt
  const go = agentLaunch(`${SYSTEM}${epic ? `\n\n${epicPrompt(epic)}` : ""}`, [...resume, "--append-system-prompt", SYSTEM, ...first]);
  const t = spawnTerm({
    cwd: config.repo.path,
    command: go.command,
    args: go.args,
    title: `lead · ${epic?.key ?? config.repo.name}`,
    session: resume.length && !go.agent ? saved.session : undefined,
  });
  writeRow(key, { ...saved, term: t.id });
  return t;
}

// Remember the conversation as soon as it starts in the lead's terminal, so closing the terminal before pressing
// the button again doesn't lose it.
export function startLeadWatch() {
  onEvent((event, data) => {
    if (event !== "session.started" || !config.repo.path) return;
    const s = data as Session;
    // the repo's lead and every epic's
    const rows = db.prepare<[string, string], { key: string }>("select key from settings where key = ? or key like ?").all(rowKey(), `${rowKey()}:%`);
    for (const { key } of rows) {
      const saved = readRow<Lead>(key);
      if (!saved?.term || s.id === saved.session) continue;
      const term = listTerms().find((t) => t.id === saved.term);
      if (term && runsIn(s, term)) writeRow(key, { ...saved, session: s.id });
    }
  });
}
