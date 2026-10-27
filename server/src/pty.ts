import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as pty from "node-pty";

// node-pty starts every terminal on a Mac through its spawn-helper, and a pnpm install leaves that file without
// its execute bit, so every terminal fails with "posix_spawnp failed". Put the bit back before anything spawns.
function fixSpawnHelper() {
  if (process.platform !== "darwin") return;
  try {
    const root = dirname(dirname(createRequire(import.meta.url).resolve("node-pty")));
    for (const dir of [`build/Release`, `prebuilds/darwin-${process.arch}`]) {
      const helper = join(root, dir, "spawn-helper");
      if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
    }
  } catch (e) {
    console.error("node-pty spawn-helper", e);
  }
}
fixSpawnHelper();
import type { WebSocket } from "ws";
import type { TermInfo } from "@cockpit/shared";
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
  // the run its command is recorded as
  run?: string;
}

interface Term extends Meta {
  proc: pty.IPty;
  scrolled?: boolean;
  pid?: number;
  scrollback: string;
  // each tmux client attached is a new epoch; offsets count the characters it has produced, and start is the
  // offset of the first one still in the scrollback, so a viewer that was away can ask for exactly what it missed
  epoch: number;
  start: number;
  end: number;
  exited?: number;
  sockets: Set<WebSocket>;
  sinks: Set<Sink>;
}

// what a terminal sends to whoever follows it besides the browsers on this machine, like a hub over its link
export interface PtyFrame {
  id: string;
  epoch: number;
  offset: number;
  data: string;
}
export type Sink = (f: PtyFrame) => void;

// Terminals on other machines, which the hub shows next to its own; set once nodes can be reached
export interface RemoteTerms {
  list(): TermInfo[];
  owns(id: string): boolean;
  attach(ws: WebSocket, id: string): void;
  detachAll(ws: WebSocket): void;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  scroll(id: string, lines: number): void;
  search(id: string, query: string, step: "find" | "next" | "prev" | "close"): void;
  kill(id: string): void;
  cwd(id: string): string | undefined;
  // a terminal it doesn't know yet but may, once a node it hasn't heard from since starting answers: true when it
  // will attach the socket itself, or tell it the terminal is gone, later
  wait(ws: WebSocket, id: string): boolean;
}
let remote: RemoteTerms | undefined;
export const useRemoteTerms = (r: RemoteTerms) => void (remote = r);

const changed = new Set<() => void>();
const exits = new Set<(id: string, code: number) => void>();
// for a node passing its terminals on: the list changed, or one ended
export const onTermsChanged = (fn: () => void) => (changed.add(fn), () => void changed.delete(fn));
export const onTermExit = (fn: (id: string, code: number) => void) => (exits.add(fn), () => void exits.delete(fn));

const MAX_SCROLLBACK = 256 * 1024;
const terms = new Map<string, Term>();

// Terminals live in their own tmux server, so restarting cockpit only drops the viewer, not what runs inside.
// Without tmux they are plain ptys and die with the server.
// a second cockpit for testing can keep to its own tmux server
const SOCKET = process.env.COCKPIT_TMUX_SOCKET || (demo ? "cockpit-demo" : "cockpit");
export const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
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
  if (spawnSync("tmux", ["-L", SOCKET, "source-file", tmuxConf]).status === 0) return syncEnv();
  // a new tmux server: whatever cockpit had open went down with the last one, a reboot say
  tmuxFresh = true;
  // a scope of its own keeps the tmux server out of the service's cgroup, so a restart doesn't take it down
  const scoped = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "tmux", "-L", SOCKET, "-f", tmuxConf, "start-server"]);
  if (scoped.status !== 0) tmux("start-server");
}

// A tmux server that outlived a restart keeps the environment it started with, so what changed in cockpit's
// (its env file, say) is copied over for the terminals opened from now on. The service's own variables stay out.
const SERVICE_ENV = /^(TMUX.*|INVOCATION_ID|JOURNAL_STREAM|MANAGERPID|SYSTEMD_EXEC_PID|NOTIFY_SOCKET|MEMORY_PRESSURE_.*|PWD|OLDPWD|SHLVL|_)$/;
function syncEnv() {
  const had = new Map(
    tmux("show-environment", "-g")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
  );
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SERVICE_ENV.test(k) && had.get(k) !== v) spawnSync("tmux", ["-L", SOCKET, "set-environment", "-g", k, v]);
}

let tmuxFresh = false;
if (hasTmux) startTmux();

const name = (id: string) => `cockpit-${id}`;
const panePid = (id: string) => Number(tmux("display-message", "-p", "-t", name(id), "#{pane_pid}").trim()) || undefined;

// from the clock, so a restart never hands a terminal an epoch it had before and a hub mistakes new output for old
let epochs = Date.now();
function connect(meta: Meta, proc: pty.IPty, pid?: number) {
  const t: Term = { ...meta, proc, pid, scrollback: "", epoch: ++epochs, start: 0, end: 0, sockets: new Set(), sinks: new Set() };
  proc.onData((data) => {
    const offset = t.end;
    t.end += data.length;
    t.scrollback += data;
    if (t.scrollback.length > MAX_SCROLLBACK) {
      t.start += t.scrollback.length - MAX_SCROLLBACK;
      t.scrollback = t.scrollback.slice(-MAX_SCROLLBACK);
    }
    for (const ws of t.sockets) send(ws, { type: "pty.data", id: t.id, data });
    for (const sink of t.sinks) sink({ id: t.id, epoch: t.epoch, offset, data });
  });
  proc.onExit(({ exitCode }) => {
    // the tmux client can drop while the session lives on, so only give up once the session is really gone
    if (hasTmux && spawnSync("tmux", ["-L", SOCKET, "has-session", "-t", name(t.id)]).status === 0) {
      if (terms.get(t.id) === t) terms.delete(t.id);
      const again = connect(meta, attachClient(meta), t.pid);
      // a new client repaints the screen from scratch, so the viewers start over with it
      again.sockets = t.sockets;
      for (const ws of again.sockets) send(ws, { type: "pty.reset", id: t.id });
      for (const sink of t.sinks) again.sinks.add(sink);
      return;
    }
    // through tmux the exit code is the client's, so a run's command leaves its own in a file; no file means it
    // was closed before its command ended
    const own = t.run ? runExit(t.run) : undefined;
    const code = own ?? exitCode;
    t.exited = code;
    for (const ws of t.sockets) send(ws, { type: "pty.exit", id: t.id, code });
    for (const fn of exits) fn(t.id, code);
    emit("terminal.exited", { id: t.id, code, run: t.run, killed: !!t.run && own === undefined, output: t.run ? t.scrollback : undefined });
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

// tmux refuses a command over about 16KB ("command too long"), like claude with a long prompt, so a long one runs
// from a script that removes itself before it starts the command
const shq = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
function launcher(id: string, file: string, args: string[]) {
  if ([file, ...args].reduce((n, a) => n + Buffer.byteLength(a) + 1, 0) < 8000) return [file, ...args];
  const script = join(tmpdir(), `cockpit-term-${id}.sh`);
  writeFileSync(script, `rm -f "$0"\nexec ${[file, ...args].map(shq).join(" ")}\n`, { mode: 0o600 });
  return ["bash", script];
}

const exitFile = (run: string) => join(paths.data, "runs", `${run}.exit`);
function runExit(run: string) {
  const f = exitFile(run);
  if (!existsSync(f)) return;
  const code = Number(readFileSync(f, "utf8").trim());
  rmSync(f, { force: true });
  return Number.isFinite(code) ? code : undefined;
}

// The Claude terminal a tool's terminal goes beside: the open one whose folder holds the new one's (the deepest, then
// the newest), so a ticket's runs and servers sit next to its session as splits instead of piling up as tabs
export function claudeTermFor(cwd: string) {
  const home = homedir();
  return [...terms.values()]
    .filter((t) => !t.parent && t.exited === undefined && (!!t.session || /^claude\b/.test(t.command)) && t.cwd !== home && t.cwd !== "/" && (cwd === t.cwd || cwd.startsWith(`${t.cwd}/`)))
    .sort((a, b) => b.cwd.length - a.cwd.length || b.createdAt - a.createdAt)[0]?.id;
}

export function spawnTerm(opts: { cwd: string; title?: string; command?: string; args?: string[]; session?: string; parent?: string; run?: string; beside?: boolean }) {
  if (opts.beside && !opts.parent) opts = { ...opts, parent: claudeTermFor(opts.cwd) };
  const shell = opts.command ?? (process.env.SHELL || "bash");
  let file = shell;
  let argv = opts.args ?? [];
  if (opts.run) {
    mkdirSync(join(paths.data, "runs"), { recursive: true });
    argv = ["-c", 'f=$1; shift; "$@"; c=$?; echo $c > "$f"; exit $c', "cockpit-run", exitFile(opts.run), shell, ...argv];
    file = "bash";
  }
  // kept with the tmux session (same 16KB limit) and only shown as a tooltip, so a long prompt is cut short
  const full = [shell, ...(opts.args ?? [])].join(" ");
  const command = full.length > 500 ? `${full.slice(0, 500)}…` : full;
  const meta: Meta = { id: randomUUID(), title: opts.title ?? command, cwd: opts.cwd, command, createdAt: Date.now(), session: opts.session, parent: opts.parent, run: opts.run };

  if (!hasTmux) {
    const proc = pty.spawn(file, argv, ptyOpts(opts.cwd));
    const t = connect(meta, proc, proc.pid);
    announce();
    emit("terminal.opened", info(t));
    return info(t);
  }

  tmux("new-session", "-d", "-s", name(meta.id), "-x", "120", "-y", "32", "-c", opts.cwd, "-e", "COLORTERM=truecolor", "--", ...launcher(meta.id, file, argv));
  tmux("set-option", "-t", name(meta.id), "@cockpit", Buffer.from(JSON.stringify(meta)).toString("base64"));
  const t = connect(meta, attachClient(meta), panePid(meta.id));
  announce();
  emit("terminal.opened", info(t));
  return info(t);
}

// The terminals open, kept on disk so the ones a reboot takes down with tmux can be opened again after it.
// While tmux itself is going down every terminal ends at once, and that mustn't empty the list.
const openFile = join(paths.data, "terms.json");
type Saved = Pick<Meta, "id" | "title" | "cwd" | "command" | "createdAt" | "session" | "parent">;
function tmuxUp() {
  const r = spawnSync("tmux", ["-L", SOCKET, "list-sessions"], { encoding: "utf8" });
  return r.status === 0 || !/no server running|error connecting/i.test(r.stderr ?? "");
}
function saveOpen() {
  if (!hasTmux || demo || !tmuxUp()) return;
  const open: Saved[] = [...terms.values()].filter((t) => t.exited === undefined && !t.run).map(({ id, title, cwd, command, createdAt, session, parent }) => ({ id, title, cwd, command, createdAt, session, parent }));
  try {
    writeFileSync(openFile, JSON.stringify(open));
  } catch {}
}

// the session running in a terminal, once the sessions poll has matched them, so it can be resumed after a reboot
export function noteSession(id: string, session: string) {
  const t = terms.get(id);
  if (!t || t.session === session) return;
  t.session = session;
  saveOpen();
}

// What was open before tmux started afresh (a reboot), parents first; nothing after a plain cockpit restart
export function lostTerms(): Saved[] {
  if (!tmuxFresh) return [];
  tmuxFresh = false;
  let saved: Saved[] = [];
  try {
    saved = JSON.parse(readFileSync(openFile, "utf8"));
  } catch {}
  return saved.filter((t) => !terms.has(t.id)).sort((a, b) => Number(!!a.parent) - Number(!!b.parent) || a.createdAt - b.createdAt);
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

const info = (t: Term): TermInfo => ({ id: t.id, title: t.title, cwd: t.cwd, command: t.command, createdAt: t.createdAt, exited: t.exited, pid: t.pid, session: t.session, parent: t.parent, node: "local", state: t.exited === undefined ? "running" : "exited" });

// Where the terminal is now, so a `cd` in a shell moves the changes panel with it.
export function currentCwd(id: string) {
  if (remote?.owns(id)) return remote.cwd(id);
  const t = terms.get(id);
  if (!t) return;
  try {
    return t.pid ? readlinkSync(`/proc/${t.pid}/cwd`) : t.cwd;
  } catch {
    return t.cwd;
  }
}

// this machine's terminals only, what a node tells its hub
export const localTerms = () => [...terms.values()].map(info);
// every terminal, this machine's and its nodes'
export const listTerms = () => [...localTerms(), ...(remote?.list() ?? [])];

// every client keeps its tab list from this push instead of polling
export function announce() {
  saveOpen();
  broadcast({ type: "terms", terms: listTerms() });
  for (const fn of changed) fn();
}

// The browser starts from a clean screen and gets the whole scrollback, so a reconnect never shows output twice
export function attach(ws: WebSocket, id: string) {
  if (remote?.owns(id)) return remote.attach(ws, id);
  const t = terms.get(id);
  if (!t) return remote?.wait(ws, id) ? undefined : send(ws, { type: "pty.exit", id, code: -1 });
  t.sockets.add(ws);
  send(ws, { type: "pty.mode", id, tmux: hasTmux });
  send(ws, { type: "pty.reset", id });
  if (t.scrollback) send(ws, { type: "pty.data", id, data: t.scrollback });
  if (t.exited !== undefined) send(ws, { type: "pty.exit", id, code: t.exited });
}

// Follows a terminal from where a viewer left off: the same epoch with its offset still in the scrollback gets
// only what came after it; anything else starts over with the whole scrollback
export function subscribe(id: string, from: { epoch: number; offset: number } | undefined, sink: Sink) {
  const t = terms.get(id);
  if (!t) return;
  const resume = !!from && from.epoch === t.epoch && from.offset >= t.start && from.offset <= t.end;
  const at = resume ? from!.offset : t.start;
  const rest = t.scrollback.slice(at - t.start);
  t.sinks.add(sink);
  if (rest) sink({ id, epoch: t.epoch, offset: at, data: rest });
  return { mode: resume ? ("resume" as const) : ("reset" as const), epoch: t.epoch, start: at, tmux: hasTmux, off: () => void terms.get(id)?.sinks.delete(sink) };
}

export function detachAll(ws: WebSocket) {
  for (const t of terms.values()) t.sockets.delete(ws);
  remote?.detachAll(ws);
}

export function input(id: string, data: string) {
  if (remote?.owns(id)) return remote.input(id, data);
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
  if (remote?.owns(id)) return remote.search(id, query, step);
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
  if (remote?.owns(id)) return remote.scroll(id, lines);
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
  if (remote?.owns(id)) return remote.resize(id, cols, rows);
  const t = terms.get(id);
  if (t && t.exited === undefined && cols > 0 && rows > 0) t.proc.resize(cols, rows);
}

export function kill(id: string) {
  if (remote?.owns(id)) return remote.kill(id);
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
