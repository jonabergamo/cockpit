// Talking to a running Claude session without opening its terminal: what it's showing, what it asked,
// and typing an answer into its tmux pane. Only sessions inside cockpit's own tmux server can be reached;
// the rest are resumed in a new cockpit terminal instead.
import type { Ask, Entry } from "@cockpit/shared";
import { liveInfo, sessionFile } from "./claude/sessions.ts";
import { parseLine, readTail } from "./claude/transcript.ts";
import { tmuxIn } from "./pty.ts";
import { agentRow, sendAgent } from "./workers/runner.ts";
import { codexTerminalPane } from "./claude/codexTerminal.ts";

export function paneOf(sessionId: string) {
  // Codex in one of cockpit's terminals: that terminal's tmux session
  const codex = codexTerminalPane(sessionId);
  if (codex) return codex;
  const t = liveInfo(sessionId)?.tmux;
  const m = t?.match(/^(cockpit-[^:]+):@\d+\.(%\d+)$/);
  if (!m) return;
  // the registry can outlive the pane, and pane ids are only unique within one tmux server: it has to be
  // this pane in this session on cockpit's own server
  try {
    return tmuxIn(["display-message", "-p", "-t", m[2], "#{session_name}"]).trim() === m[1] ? m[2] : undefined;
  } catch {
    return;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function leaveCopyMode(pane: string) {
  try {
    if (tmuxIn(["display-message", "-p", "-t", pane, "#{pane_in_mode}"]).trim() === "1") tmuxIn(["send-keys", "-t", pane, "-X", "cancel"]);
  } catch {}
}

// whether a message can reach it: a pane of cockpit's tmux, or an agent cockpit runs a turn at a time
export const canSend = (sessionId: string) => !!agentRow(sessionId) || !!paneOf(sessionId);

// A bracketed paste, so several lines arrive as one message, then Enter. An agent run a turn at a time gets it as
// its next prompt instead.
export async function sendText(sessionId: string, text: string) {
  if (agentRow(sessionId)) return sendAgent(sessionId, text);
  const pane = paneOf(sessionId);
  if (!pane) return false;
  leaveCopyMode(pane);
  tmuxIn(["load-buffer", "-b", "cockpit-send", "-"], text);
  tmuxIn(["paste-buffer", "-p", "-d", "-b", "cockpit-send", "-t", pane]);
  await sleep(150);
  tmuxIn(["send-keys", "-t", pane, "Enter"]);
  return true;
}

const KEYS = new Set(["Enter", "Escape", "Up", "Down", "Tab", "BTab", "Space"]);

// Menu answers: "1", "2", Escape and friends. Anything else is refused, so this can't type arbitrary commands.
export function sendKeys(sessionId: string, keys: string[]) {
  const pane = paneOf(sessionId);
  if (!pane) return false;
  const ok = keys.filter((k) => /^[0-9]$/.test(k) || /^[yn]$/i.test(k) || KEYS.has(k));
  if (!ok.length) return false;
  leaveCopyMode(pane);
  tmuxIn(["send-keys", "-t", pane, ...ok]);
  return true;
}

export function capture(sessionId: string, lines = 60) {
  const pane = paneOf(sessionId);
  return pane ? captureTarget(pane, lines) : undefined;
}

// a terminal cockpit started, before (or without) a Claude session showing up in it
export const termTarget = (termId: string) => `cockpit-${termId}`;
export function captureTarget(target: string, lines = 60) {
  try {
    return tmuxIn(["capture-pane", "-p", "-J", "-t", target, "-S", `-${lines}`]);
  } catch {
    return;
  }
}

// Claude asks before it works in a folder it hasn't seen, which every new worktree is
export const trustDialog = (screen?: string) => !!screen && /trust this folder/i.test(screen);
export function acceptTrust(termId: string) {
  // the dialog's options aren't numbered: the cursor starts on "No, exit", one down is "Yes"
  tmuxIn(["send-keys", "-t", termTarget(termId), "Down"]);
  tmuxIn(["send-keys", "-t", termTarget(termId), "Enter"]);
}

const isRule = (l: string) => /^[\s─━╌┄-]{20,}/.test(l) && (l.match(/[─━]/g)?.length ?? 0) > 20;

// Claude's screen ends with its input box between two rules and a status line under it. What's above the box
// is the conversation, and a numbered menu near the bottom of it is a question waiting for an answer.
export function parseScreen(screen: string): Ask {
  const lines = screen.replace(/\s+$/, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  // a permission or question dialog takes the input box's place at the bottom, so look for it first
  const menu = findMenu(lines);
  if (menu) return { screen: lines.slice(Math.max(0, menu.top - 18), menu.bottom + 1).join("\n"), question: menu.question, options: menu.options };

  const rules = lines.map((l, i) => (isRule(l) ? i : -1)).filter((i) => i >= 0);
  let body = lines;
  let draft = "";
  if (rules.length >= 2) {
    const [a, b] = rules.slice(-2);
    draft = lines
      .slice(a + 1, b)
      .join("\n")
      .replace(/^\s*❯\s?/, "")
      .trim();
    body = lines.slice(0, a);
  } else if (rules.length === 1) body = lines.slice(0, rules[0]);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return { screen: body.slice(-24).join("\n"), options: [], draft: draft || undefined };
}

// "❯ 1. Yes", "  2. No", possibly inside a │ box, at the very bottom of the screen with the ❯ cursor on one
// option. A numbered list Claude wrote has neither, so it isn't taken for a menu.
function findMenu(lines: string[]) {
  const opt = /^[\s│┃]*(?:❯\s*)?(\d)\.\s+(.+?)[\s│┃]*$/;
  // options can carry an indented description line under them (Claude's question tool does)
  const indented = /^[\s│┃]{4,}\S/;
  let end = lines.length - 1;
  while (end >= 0 && (!lines[end].trim() || /^[\s│┃╰╯─]*$/.test(lines[end]) || /esc to|enter to|tab to/i.test(lines[end]))) end--;
  const found: { key: string; label: string }[] = [];
  let cursor = false;
  let i = end;
  while (i >= 0 && end - i < 40) {
    const m = lines[i].match(opt);
    if (m) {
      found.unshift({ key: m[1], label: m[2] });
      if (lines[i].includes("❯")) cursor = true;
    } else if (!(indented.test(lines[i]) || !lines[i].trim()) || (!found.length && end - i > 6)) break;
    i--;
  }
  if (!cursor || found.length < 2 || found[0].key !== "1") return;
  const above: string[] = [];
  for (let j = i; j >= Math.max(0, i - 8); j--) {
    const t = lines[j].replace(/^[\s│┃╭╮]*/, "").replace(/[\s│┃╭╮]*$/, "");
    if (t && !/^[─╌]+$/.test(t)) above.push(t);
  }
  return { options: found, question: above.find((t) => t.endsWith("?")) ?? above[0], top: i, bottom: end };
}

// The last thing Claude said and a tool call still waiting on its result (usually a permission prompt).
export async function lastWords(sessionId: string) {
  const file = sessionFile(sessionId);
  if (!file) return {};
  const tail = await readTail(file, 256 * 1024).catch(() => undefined);
  if (!tail) return {};
  const entries: Entry[] = tail.lines.flatMap((l) => parseLine(l));
  const done = new Set(entries.flatMap((e) => (e.kind === "tool_result" ? [e.toolUseId] : [])));
  let text: string | undefined;
  let pending: { name: string; input: unknown } | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!pending && e.kind === "tool" && !done.has(e.toolUseId) && !text) pending = { name: e.name, input: e.input };
    if (e.kind === "assistant" && e.text.trim()) {
      text = e.text.trim();
      break;
    }
    if (e.kind === "user") break;
  }
  return { text: text && text.length > 1500 ? `${text.slice(0, 1500)}…` : text, pending };
}

export async function askOf(sessionId: string) {
  // an agent without a terminal never asks mid-turn; it's reached by its next prompt
  if (agentRow(sessionId)) return { reachable: true, options: [], last: (await lastWords(sessionId)).text };
  const screen = capture(sessionId);
  const words = await lastWords(sessionId);
  return { reachable: !!screen, ...(screen ? parseScreen(screen) : { options: [] }), last: words.text, pending: words.pending };
}
