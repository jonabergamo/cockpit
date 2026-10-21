import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readlinkSync, writeFileSync } from "node:fs";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import { demo, paths } from "./config.ts";
import { emit } from "./events.ts";
import { broadcast, send } from "./hub.ts";

interface Meta {
  id: string;
  title: string;
  cwd: string;
  command: string;
  createdAt: number;
  session?: string;
  parent?: string;
}

interface Term extends Meta {
  proc: pty.IPty;
  scrolled?: boolean;
  pid?: number;
  scrollback: string;
  exited?: number;
  sockets: Set<WebSocket>;
}

const MAX_SCROLLBACK = 256 * 1024;
const terms = new Map<string, Term>();

// Terminals live in their own tmux server, so restarting cockpit only drops the viewer, not what runs inside.
// Without tmux they are plain ptys and die with the server.
// a second cockpit for testing can keep to its own tmux server
const SOCKET = process.env.COCKPIT_TMUX_SOCKET || (demo ? "cockpit-demo" : "cockpit");
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const tmuxConf = `${paths.data}/${SOCKET}.tmux.conf`;

const tmux = (...args: string[]) => execFileSync("tmux", ["-L", SOCKET, "-f", tmuxConf, ...args], { encoding: "utf8" });

// For talking to panes cockpit hosts but didn't start itself, like a claude run from one of its shells
export const tmuxIn = (args: string[], input?: string) => execFileSync("tmux", ["-L", SOCKET, "-f", tmuxConf, ...args], { encoding: "utf8", input });
export const tmuxSocket = SOCKET;

function startTmux() {
  writeFileSync(
    tmuxConf,
    [
      "set -g exit-empty off",
      "set -g prefix None",
      "unbind C-b",
      "set -g status off",
      "set -g escape-time 0",
      "set -g history-limit 50000",
      "set -g default-terminal tmux-256color",
      "set -g window-size latest",
      // mouse stays off so selecting text works as in a plain terminal; the wheel is sent over as scroll commands
      "set -g mouse off",
      "set -g terminal-overrides ',xterm*:Tc'",
      // pass OSC 8 hyperlinks through (claude prints PR and file links that way); a fixed slot so re-sourcing doesn't pile up
      "set -s terminal-features[9] 'xterm*:hyperlinks'",
      // what claude copies from its own selection (OSC 52, or its tmux buffer) goes on to the browser's clipboard
      "set -s terminal-features[10] 'xterm*:clipboard'",
      "set -g set-clipboard on",
      "set -g allow-passthrough on",
      "",
    ].join("\n"),
  );
  // only works when our tmux server is already up, which is the case after a cockpit restart
  if (spawnSync("tmux", ["-L", SOCKET, "source-file", tmuxConf]).status === 0) return;
  // a scope of its own keeps the tmux server out of the service's cgroup, so a restart doesn't take it down
  const scoped = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "tmux", "-L", SOCKET, "-f", tmuxConf, "start-server"]);
  if (scoped.status !== 0) tmux("start-server");
}

if (hasTmux) startTmux();

const name = (id: string) => `cockpit-${id}`;
const panePid = (id: string) => Number(tmux("display-message", "-p", "-t", name(id), "#{pane_pid}").trim()) || undefined;

function connect(meta: Meta, proc: pty.IPty, pid?: number) {
  const t: Term = { ...meta, proc, pid, scrollback: "", sockets: new Set() };
  proc.onData((data) => {
    t.scrollback += data;
    if (t.scrollback.length > MAX_SCROLLBACK) t.scrollback = t.scrollback.slice(-MAX_SCROLLBACK);
    for (const ws of t.sockets) send(ws, { type: "pty.data", id: t.id, data });
  });
  proc.onExit(({ exitCode }) => {
    // the tmux client can drop while the session lives on, so only give up once the session is really gone
    if (hasTmux && spawnSync("tmux", ["-L", SOCKET, "has-session", "-t", name(t.id)]).status === 0) {
      if (terms.get(t.id) === t) terms.delete(t.id);
      const again = connect(meta, attachClient(meta), t.pid);
      again.sockets = t.sockets;
      return;
    }
    t.exited = exitCode;
    for (const ws of t.sockets) send(ws, { type: "pty.exit", id: t.id, code: exitCode });
    // an ended terminal has nothing left to show, so it closes itself
    if (terms.get(t.id) === t) {
      terms.delete(t.id);
      announce();
    }
  });
  terms.set(t.id, t);
  return t;
}

const ptyOpts = (cwd: string) => ({
  name: "xterm-256color",
  cols: 120,
  rows: 32,
  cwd,
  env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
});

const attachClient = (meta: Meta) => pty.spawn("tmux", ["-L", SOCKET, "-f", tmuxConf, "attach-session", "-t", name(meta.id)], ptyOpts(meta.cwd));

export function spawnTerm(opts: { cwd: string; title?: string; command?: string; args?: string[]; session?: string; parent?: string }) {
  const file = opts.command ?? (process.env.SHELL || "bash");
  const command = [file, ...(opts.args ?? [])].join(" ");
  const meta: Meta = { id: randomUUID(), title: opts.title ?? command, cwd: opts.cwd, command, createdAt: Date.now(), session: opts.session, parent: opts.parent };

  if (!hasTmux) {
    const proc = pty.spawn(file, opts.args ?? [], ptyOpts(opts.cwd));
    const t = connect(meta, proc, proc.pid);
    announce();
    emit("terminal.opened", info(t));
    return info(t);
  }

  tmux("new-session", "-d", "-s", name(meta.id), "-x", "120", "-y", "32", "-c", opts.cwd, "-e", "COLORTERM=truecolor", "--", file, ...(opts.args ?? []));
  tmux("set-option", "-t", name(meta.id), "@cockpit", Buffer.from(JSON.stringify(meta)).toString("base64"));
  const t = connect(meta, attachClient(meta), panePid(meta.id));
  announce();
  emit("terminal.opened", info(t));
  return info(t);
}

// Pick up the terminals that kept running while cockpit was down.
export function restoreTerms() {
  if (!hasTmux) return 0;
  let out = "";
  try {
    out = tmux("list-sessions", "-F", "#{session_name}\t#{@cockpit}");
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of out.split("\n")) {
    const [session, raw] = line.split("\t");
    if (!session?.startsWith("cockpit-") || !raw) continue;
    try {
      const meta = JSON.parse(Buffer.from(raw, "base64").toString()) as Meta;
      if (terms.has(meta.id)) continue;
      connect(meta, attachClient(meta), panePid(meta.id));
      n++;
    } catch {
      // not ours or unreadable, leave it alone
    }
  }
  return n;
}

const info = (t: Term) => ({ id: t.id, title: t.title, cwd: t.cwd, command: t.command, createdAt: t.createdAt, exited: t.exited, pid: t.pid, session: t.session, parent: t.parent });

// Where the terminal is now, so a `cd` in a shell moves the changes panel with it.
export function currentCwd(id: string) {
  const t = terms.get(id);
  if (!t) return;
  try {
    return t.pid ? readlinkSync(`/proc/${t.pid}/cwd`) : t.cwd;
  } catch {
    return t.cwd;
  }
}

export const listTerms = () => [...terms.values()].map(info);

// every client keeps its tab list from this push instead of polling
const announce = () => broadcast({ type: "terms", terms: listTerms() });

export function attach(ws: WebSocket, id: string) {
  const t = terms.get(id);
  if (!t) return send(ws, { type: "pty.exit", id, code: -1 });
  t.sockets.add(ws);
  send(ws, { type: "pty.mode", id, tmux: hasTmux });
  if (t.scrollback) send(ws, { type: "pty.data", id, data: t.scrollback });
  if (t.exited !== undefined) send(ws, { type: "pty.exit", id, code: t.exited });
}

export function detachAll(ws: WebSocket) {
  for (const t of terms.values()) t.sockets.delete(ws);
}

export function input(id: string, data: string) {
  const t = terms.get(id);
  if (!t) return;
  // typing while scrolled back would land in tmux's copy mode, so jump back to the live screen first
  if (t.scrolled) {
    t.scrolled = false;
    try {
      tmux("send-keys", "-t", name(id), "-X", "cancel");
    } catch {
      // already back at the bottom
    }
  }
  t.proc.write(data);
}

// Search the tmux history: the first query starts copy mode and searches up, next/prev repeat it, close leaves.
export function search(id: string, query: string, step: "find" | "next" | "prev" | "close") {
  const t = terms.get(id);
  if (!t || !hasTmux) return;
  const target = name(id);
  const args =
    step === "close"
      ? ["send-keys", "-t", target, "-X", "cancel"]
      : step === "find"
        ? ["copy-mode", "-t", target, ";", "send-keys", "-t", target, "-X", "search-backward-text", query]
        : ["send-keys", "-t", target, "-X", step === "next" ? "search-again" : "search-reverse"];
  t.scrolled = step !== "close";
  execFile("tmux", ["-L", SOCKET, "-f", tmuxConf, ...args], () => {});
}

// Positive lines go back in history. Copy mode with -e leaves by itself once you scroll to the bottom.
// A full-screen app (claude's own renderer, less, vim) draws on the alternate screen, where tmux keeps no
// history, so the wheel goes to the app: as wheel events when it listens to the mouse, else as arrow keys.
// Everything else scrolls tmux's own history.
export function scroll(id: string, lines: number) {
  const t = terms.get(id);
  if (!t || !hasTmux || !lines) return;
  const target = name(id);
  const run = (...args: string[]) => execFile("tmux", ["-L", SOCKET, "-f", tmuxConf, ...args], () => {});
  execFile("tmux", ["-L", SOCKET, "-f", tmuxConf, "display", "-p", "-t", target, "#{alternate_on} #{mouse_any_flag} #{pane_in_mode}"], (err, out) => {
    const [alt, mouse, inMode] = (err ? "" : out).trim().split(" ");
    if (alt === "1" && inMode !== "1") {
      const n = Math.min(Math.abs(lines), 15);
      // SGR mouse wheel, 64 up and 65 down, in the middle of the screen
      if (mouse === "1") t.proc.write(`\x1b[<${lines > 0 ? 64 : 65};${Math.ceil(t.proc.cols / 2)};${Math.ceil(t.proc.rows / 2)}M`.repeat(n));
      else run("send-keys", "-t", target, "-N", String(n), lines > 0 ? "Up" : "Down");
      return;
    }
    const n = String(Math.min(Math.abs(lines), 500));
    if (lines > 0) t.scrolled = true;
    if (lines > 0) run("copy-mode", "-e", "-t", target, ";", "send-keys", "-t", target, "-X", "-N", n, "scroll-up");
    else run("send-keys", "-t", target, "-X", "-N", n, "scroll-down");
  });
}

export function resize(id: string, cols: number, rows: number) {
  const t = terms.get(id);
  if (t && t.exited === undefined && cols > 0 && rows > 0) t.proc.resize(cols, rows);
}

export function kill(id: string) {
  const t = terms.get(id);
  if (!t) return;
  if (hasTmux) {
    try {
      tmux("kill-session", "-t", name(id));
    } catch {
      // already gone
    }
  }
  if (t.exited === undefined) t.proc.kill();
  terms.delete(id);
  // its split shells go with it
  for (const c of [...terms.values()]) if (c.parent === id) kill(c.id);
  announce();
}
