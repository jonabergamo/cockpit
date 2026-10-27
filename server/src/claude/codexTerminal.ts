// Codex conversations opened in a terminal (the lead, Start Codex, codex typed into a shell), listed with the
// sessions cockpit knows: from the files Codex writes for each one (~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl),
// read a little at a time as they grow. The ones cockpit runs a turn at a time are its own agent sessions already,
// and the ones Claude Code's Codex plugin starts aren't yours, so only Codex's own terminal ones are kept.
// Codex writes nothing down while it asks for a permission, so a session in one of cockpit's terminals is read off
// its screen for that.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Entry, Session } from "@cockpit/shared";
import { codexHome, codexTitles } from "../codexUsage.ts";
import { listTerms, tmuxIn } from "../pty.ts";
import { readFrom } from "./transcript.ts";

interface Tui {
  id: string;
  file: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  offset: number;
  size: number;
  model?: string;
  title?: string;
  lastPrompt?: string;
  // a turn started and not finished yet
  turnOpen: boolean;
  tokens: { input: number; output: number };
  // Codex's own, codex-tui for its terminal app; others are left out
  originator?: string;
}

const tuis = new Map<string, Tui>();
const byFile = new Map<string, Tui>();

// what a user typed, without the context Codex adds as user messages (the environment, AGENTS.md...)
const typed = (text: string) => (text.trimStart().startsWith("<") || text.startsWith("# AGENTS.md") ? undefined : text.trim());
const textOf = (content: unknown) =>
  Array.isArray(content)
    ? content
        .map((c: { text?: string }) => c?.text ?? "")
        .filter(Boolean)
        .join("\n")
    : typeof content === "string"
      ? content
      : "";

function read(t: Tui, line: string) {
  if (!line) return;
  let d: { type?: string; timestamp?: string; payload?: Record<string, any> };
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  const p = d.payload ?? {};
  if (d.type === "session_meta") {
    t.id = p.id ?? t.id;
    t.cwd = p.cwd ?? t.cwd;
    t.originator = p.originator;
    t.startedAt = Date.parse(p.timestamp ?? d.timestamp ?? "") || t.startedAt;
  } else if (d.type === "turn_context" && typeof p.model === "string") t.model = p.model;
  else if (d.type === "event_msg" && p.type === "task_started") t.turnOpen = true;
  else if (d.type === "event_msg" && (p.type === "task_complete" || p.type === "turn_aborted")) t.turnOpen = false;
  else if (d.type === "event_msg" && p.type === "token_count" && p.info?.total_token_usage) {
    const u = p.info.total_token_usage;
    t.tokens = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
  } else if (d.type === "response_item" && p.type === "message" && p.role === "user") {
    const text = typed(textOf(p.content));
    if (text) {
      t.title ??= text.slice(0, 120);
      t.lastPrompt = text.slice(0, 500);
    }
  }
}

async function scanFile(file: string) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return;
  }
  let t = byFile.get(file);
  if (t && t.size === st.size) return;
  if (!t || st.size < t.offset) {
    t = { id: "", file, cwd: "", startedAt: st.birthtimeMs || st.mtimeMs, updatedAt: st.mtimeMs, offset: 0, size: 0, turnOpen: false, tokens: { input: 0, output: 0 } };
    byFile.set(file, t);
  }
  while (t.offset < st.size) {
    const chunk = await readFrom(file, t.offset);
    if (chunk.offset === t.offset) break;
    for (const l of chunk.lines) read(t, l);
    t.offset = chunk.offset;
  }
  t.size = st.size;
  t.updatedAt = st.mtimeMs;
  if (t.id && t.originator === "codex-tui") tuis.set(t.id, t);
}

// the day folders of the last week, newest first
function recentFiles(days = 7) {
  const out: string[] = [];
  const root = join(codexHome(), "sessions");
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 864e5);
    const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {}
    for (const n of names) if (n.startsWith("rollout-") && n.endsWith(".jsonl")) out.push(join(dir, n));
  }
  return out;
}

let titles = new Map<string, string>();
let titlesAt = 0;

// Reads what changed since the last look; cheap when nothing did, so it runs with every sessions poll
export async function scanCodexTerminals() {
  for (const f of recentFiles()) await scanFile(f);
  if (Date.now() - titlesAt > 30_000) {
    titlesAt = Date.now();
    titles = await codexTitles().catch(() => titles);
  }
}

// The cockpit terminal a session runs in. A terminal cockpit opened with a prompt (codex "<prompt>") is the one
// whose session began with that prompt; otherwise the live one opened in its folder just before it started.
// Of the sessions in one terminal (codex can start a new one with /new) only the latest is the live one.
const promptOf = (command: string) => command.replace(/^\S*codex\s*/, "").trim();
const same = (a: string, b: string) => {
  const n = (x: string) => x.replace(/\s+/g, " ").trim().slice(0, 60);
  return !!a && !!b && (n(a) === n(b) || n(b).startsWith(n(a)) || n(a).startsWith(n(b)));
};
function terminalsOf(list: Tui[]) {
  const terms = listTerms().filter((t) => t.exited === undefined && (!t.node || t.node === "local") && /(^|\/)codex\b/.test(t.command));
  // each terminal opened with a prompt began one session: of those with its prompt, the first to start after it
  // opened, so two terminals given the same prompt (reviewing one PR twice) each get their own
  const byPrompt = new Map<string, string>();
  const taken = new Set<string>();
  for (const t of [...list].sort((a, b) => a.startedAt - b.startedAt)) {
    const term = terms
      .filter((x) => !taken.has(x.id) && x.createdAt <= t.startedAt + 5000 && !!t.title && same(promptOf(x.command), t.title))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (term) byPrompt.set(t.id, term.id), taken.add(term.id);
  }
  const prompted = new Map([...byPrompt].map(([sid, tid]) => [tid, list.find((x) => x.id === sid)!]));
  const newest = new Map<string, Tui>();
  for (const t of list) {
    let term = byPrompt.get(t.id);
    if (!term) {
      // a terminal opened with another prompt only takes sessions started after that one, with /new
      const fits = terms.filter((x) => x.cwd === t.cwd && x.createdAt <= t.startedAt + 5000 && (!prompted.has(x.id) || prompted.get(x.id)!.startedAt < t.startedAt));
      term = fits.sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
    }
    if (term && (!newest.has(term) || newest.get(term)!.startedAt < t.startedAt)) newest.set(term, t);
  }
  return new Map([...newest].map(([term, t]) => [t.id, term]));
}

// what a terminal shows when Codex asks before doing something
const ASKING = /enter to submit \| esc to cancel|Would you like to (run|make|apply)|Allow .{1,200}\?|Press enter to (confirm|continue)/;
const screens = new Map<string, { at: number; asking: boolean }>();
function asking(termId: string) {
  const had = screens.get(termId);
  if (had && Date.now() - had.at < 1200) return had.asking;
  let text = "";
  try {
    text = tmuxIn(["capture-pane", "-p", "-J", "-t", `cockpit-${termId}`]);
  } catch {}
  const v = ASKING.test(text.split("\n").slice(-30).join("\n"));
  screens.set(termId, { at: Date.now(), asking: v });
  return v;
}

const RECENT_MS = 30 * 60_000;

// Codex's terminal sessions as cockpit lists sessions. Live while its terminal is (or, outside cockpit's terminals,
// while its file is fresh): busy in a turn, waiting while it asks for permission, idle otherwise.
export function codexTerminalSessions(): Session[] {
  const list = [...tuis.values()];
  const termOf = terminalsOf(list);
  return list.map((t) => {
    const term = termOf.get(t.id);
    const fresh = Date.now() - t.updatedAt < RECENT_MS;
    let status: Session["status"] = term ? "idle" : fresh && t.turnOpen ? "busy" : "ended";
    let waitingFor: string | undefined;
    if (term && t.turnOpen) status = asking(term) ? "waiting" : "busy";
    if (status === "waiting") waitingFor = "permission";
    // a turn left open by a codex that was closed mid-turn isn't still working
    if (status === "busy" && !term && !fresh) status = "ended";
    const title = titles.get(t.id) ?? t.title;
    return {
      id: t.id,
      project: t.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
      cwd: t.cwd,
      title,
      status,
      waitingFor,
      startedAt: t.startedAt,
      updatedAt: t.updatedAt,
      lastPrompt: t.lastPrompt,
      size: t.size,
      term,
      agent: "codex",
      model: t.model,
      tokens: t.tokens,
    } satisfies Omit<Session, "ticket" | "branch" | "worktree">;
  });
}

export const codexTerminalFile = (id: string) => tuis.get(id)?.file;
export const isCodexTerminal = (id: string) => tuis.has(id);
// for search: each session's file, and what to show for a hit
export const codexTerminalFiles = () => [...tuis.values()].map((t) => ({ id: t.id, file: t.file }));
export const codexTerminalMeta = (id: string) => {
  const t = tuis.get(id);
  return t && { title: titles.get(id) ?? t.title ?? null, cwd: t.cwd || null, last_ts: new Date(t.updatedAt).toISOString() };
};
// the tmux pane a message for it goes into, when it runs in one of cockpit's terminals
export const codexTerminalPane = (id: string) => {
  const term = tuis.has(id) ? terminalsOf([...tuis.values()]).get(id) : undefined;
  return term && `cockpit-${term}`;
};

// ---- the transcript, as the session page shows any session ----

// Codex runs commands through a small script: tools.exec_command({cmd: "..."}) for a shell command,
// tools.mcp__<server>__<tool>(...) for an MCP tool
function toolOf(input: string): { name: string; input: unknown } {
  const cmd = input.match(/exec_command\(\{\s*cmd:\s*("(?:[^"\\]|\\.)*")/)?.[1];
  if (cmd) {
    try {
      return { name: "Bash", input: { command: JSON.parse(cmd) } };
    } catch {}
  }
  const mcp = input.match(/tools\.mcp__([\w-]+?)__(\w+)\(/);
  if (mcp) return { name: `${mcp[1]}.${mcp[2]}`, input: { code: input } };
  return { name: "Code", input: { code: input } };
}

// One line of a Codex session file as transcript entries
export function codexEntries(line: string): Entry[] {
  let d: { type?: string; timestamp?: string; ordinal?: number; payload?: Record<string, any> };
  try {
    d = JSON.parse(line);
  } catch {
    return [];
  }
  const p = d.payload ?? {};
  const ts = d.timestamp ?? new Date().toISOString();
  const id = `${d.ordinal ?? ts}`;
  if (d.type !== "response_item") return [];
  if (p.type === "message" && p.role === "user") {
    const text = typed(textOf(p.content));
    return text ? [{ kind: "user", id, ts, text }] : [];
  }
  if (p.type === "message" && p.role === "assistant") {
    const text = textOf(p.content).trim();
    return text ? [{ kind: "assistant", id, ts, text }] : [];
  }
  if (p.type === "reasoning") {
    const text = textOf(p.summary).trim();
    return text ? [{ kind: "thinking", id, ts, text }] : [];
  }
  if (p.type === "custom_tool_call" && typeof p.input === "string") return [{ kind: "tool", id, ts, toolUseId: p.call_id ?? id, ...toolOf(p.input) }];
  if (p.type === "function_call") {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(p.arguments ?? "{}");
    } catch {}
    const command = Array.isArray(args.command) ? (args.command as string[]).join(" ") : (args.cmd ?? args.command);
    return [{ kind: "tool", id, ts, toolUseId: p.call_id ?? id, name: command ? "Bash" : String(p.name ?? "tool"), input: command ? { command } : args }];
  }
  if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
    const raw = typeof p.output === "string" ? p.output : textOf(p.output);
    const text = raw.replace(/^Script completed\nWall time [^\n]*\n(Output:\n)?/, "");
    return [{ kind: "tool_result", id, ts, toolUseId: p.call_id ?? id, text: text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text, isError: /^Script (failed|errored)|Process exited with code [1-9]/m.test(raw) }];
  }
  return [];
}
