// Runs: every test, lint, typecheck, audit, e2e, proof, verify and CI run, wherever it started (a Claude Bash hook,
// `cockpit run`, a terminal, verify, a plugin, a script of yours). A run is a row in the runs table, its
// output is data/runs/<id>.log and its files are in data/runs/<id>/.
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, appendFileSync, renameSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Run, RunArtifact, RunEvent, RunFilter, RunKind, RunStart, RunStatus, RunSummary, Worktree } from "@cockpit/shared";
import { paths } from "./config.ts";
import { db } from "./db.ts";
import { emit, onEvent } from "./events.ts";
import { broadcast } from "./hub.ts";
import { notify } from "./notify.ts";
import { sprintTickets } from "./providers.ts";
import { listTerms, spawnTerm } from "./pty.ts";
import { getSettings, type Settings } from "./settings.ts";
import { run, ticketOf } from "./util.ts";
import { listWorktrees } from "./worktrees.ts";

export const KINDS: RunKind[] = ["unit", "lint", "typecheck", "audit", "e2e", "proof", "verify", "ci", "other"];
const STATUSES: RunStatus[] = ["running", "pass", "fail", "cancelled"];
const MAX_LOG = 2 * 1024 * 1024;
const KEEP_DAYS = 90;
const KEEP_RUNS = 3000;
// a script that reports as it goes and then goes quiet this long has died without saying so
const QUIET_MS = 10 * 60_000;
// Claude already sees what it ran, and verify notifies by itself
const QUIET_SOURCES = new Set(["hook", "mcp", "verify"]);
// a failure worth telling you about: not from a quiet source, and not copied in or caught up on after the fact
export const failureIsNews = (r: Pick<Run, "status" | "source" | "meta">) => r.status === "fail" && !r.meta.quiet && !QUIET_SOURCES.has(r.source);

export const runsDir = join(paths.data, "runs");
mkdirSync(runsDir, { recursive: true });
export const logFile = (id: string) => join(runsDir, `${id}.log`);
const stepsFile = (id: string) => join(runsDir, `${id}.steps`);
export const filesDir = (id: string) => join(runsDir, id);

// colours, cursor moves, OSC titles and the charset and keypad switches a terminal (or tmux) sends
const ANSI = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]|\r/g;
export const strip = (s: string) => s.replace(ANSI, "");

interface Row {
  id: string;
  kind: string;
  name: string;
  source: string;
  ticket: string | null;
  worktree: string | null;
  cwd: string | null;
  command: string | null;
  status: string;
  exit_code: number | null;
  started_at: number;
  ended_at: number | null;
  updated_at: number;
  summary: string;
  artifacts: string;
  meta: string;
}

const toRun = (r: Row): Run => ({
  id: r.id,
  kind: r.kind as RunKind,
  name: r.name,
  source: r.source,
  ticket: r.ticket ?? undefined,
  worktree: r.worktree ?? undefined,
  cwd: r.cwd ?? undefined,
  command: r.command ?? undefined,
  status: r.status as RunStatus,
  exitCode: r.exit_code ?? undefined,
  startedAt: r.started_at,
  endedAt: r.ended_at ?? undefined,
  updatedAt: r.updated_at,
  summary: JSON.parse(r.summary),
  artifacts: JSON.parse(r.artifacts),
  meta: JSON.parse(r.meta),
});

const rowOf = (id: string) => db.prepare<[string], Row>("select * from runs where id = ?").get(id);

function save(r: Run) {
  db.prepare(
    `insert or replace into runs (id, kind, name, source, ticket, worktree, cwd, command, status, exit_code, started_at, ended_at, updated_at, summary, artifacts, meta)
     values (@id, @kind, @name, @source, @ticket, @worktree, @cwd, @command, @status, @exitCode, @startedAt, @endedAt, @updatedAt, @summary, @artifacts, @meta)`,
  ).run({
    ...r,
    ticket: r.ticket ?? null,
    worktree: r.worktree ?? null,
    cwd: r.cwd ?? null,
    command: r.command ?? null,
    exitCode: r.exitCode ?? null,
    endedAt: r.endedAt ?? null,
    summary: JSON.stringify(r.summary),
    artifacts: JSON.stringify(r.artifacts),
    meta: JSON.stringify(r.meta),
  });
}

// ---- working out what a run is ----

type Patterns = Settings["runs"]["patterns"];
const ORDER = ["e2e", "audit", "typecheck", "lint", "unit"] as const;

// What the patterns are matched against: the commands without their quoted text, heredoc bodies, variable
// assignments or path arguments, so `git commit -m "fix the tests"`, `cd src/maestro && ls` and a heredoc that
// mentions e2e aren't runs. Each command keeps its own word, path or not, and they stay apart on `;`.
export function commandWords(command: string) {
  const bare = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "")
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  return bare
    .split(/&&|\|\||[;&|\n]/)
    .map((part) => {
      const words = part.trim().split(/\s+/).filter(Boolean);
      while (words.length > 1 && /^\w+=/.test(words[0])) words.shift();
      if (words[0] === "cd" || words[0] === "pushd") return "";
      return [words[0], ...words.slice(1).filter((w) => !w.includes("/"))].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join(" ; ");
}

// The kind a command's run is, from the patterns in Settings, or undefined when it isn't one
export function kindOf(command: string, patterns: Patterns = getSettings().runs.patterns): RunKind | undefined {
  const bare = commandWords(command);
  for (const kind of ORDER) {
    const p = patterns[kind];
    if (!p) continue;
    try {
      if (new RegExp(p, "i").test(bare)) return kind;
    } catch {
      // checked when it was saved, so only a hand-edited row gets here
    }
  }
}

const inside = (root: string, p?: string) => !!p && (p === root || p.startsWith(root + "/"));

// The worktree a run belongs to and its ticket: what it was given, then the worktree its cwd is in (or that has its
// branch), then a key in its name or cwd, the way k.ticketOf finds one.
export function placeOf(r: { cwd?: string; branch?: string; name?: string; ticket?: string; worktree?: string }, worktrees: Pick<Worktree, "path" | "branch" | "ticket" | "main">[]) {
  const wt =
    worktrees.find((w) => w.path === r.worktree) ??
    worktrees.filter((w) => !w.main && inside(w.path, r.cwd)).sort((a, b) => b.path.length - a.path.length)[0] ??
    (r.branch ? worktrees.find((w) => !w.main && w.branch === r.branch) : undefined);
  return { worktree: r.worktree ?? wt?.path, ticket: r.ticket || wt?.ticket || ticketOf(r.name, r.branch, wt?.branch, r.cwd) };
}

// Counts and failing tests from the end of a runner's output: vitest, jest, mocha, pytest, go and the like.
export function countsOf(lines: string[]): RunSummary {
  const text = lines.slice(-600).map(strip);
  const out: RunSummary = {};
  const total = text.findLast((l) => /^\s*(Tests:?|Test Files|=+|\d+ (passing|failing))\s.*\b\d+ (passed|failed|passing|failing)\b/i.test(l) || /^\s*\d+ (passing|failing)\b/.test(l));
  if (total) {
    for (const [, n, word] of total.matchAll(/(\d+) (passed|passing|failed|failing|skipped|pending|todo)/gi)) {
      const k = /pass/i.test(word) ? "passed" : /fail/i.test(word) ? "failed" : "skipped";
      out[k] = (out[k] ?? 0) + Number(n);
    }
  }
  const failing = new Set<string>();
  for (const l of text) {
    const m = l.match(/^\s*(?:FAIL|FAILED|--- FAIL:|[×✕✗])\s+(.+?)\s*(?:\(?\d+(?:\.\d+)?\s?m?s\)?)?$/) ?? l.match(/^\s*●\s+(?!Console)(.+›.+)$/);
    if (m && failing.size < 20) failing.add(m[1].slice(0, 200));
  }
  if (failing.size) out.failing = [...failing];
  return out;
}

const typeOf = (name: string) => {
  const e = extname(name).toLowerCase();
  if ([".mp4", ".webm", ".mov", ".m4v"].includes(e)) return "video";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(e)) return "image";
  if ([".txt", ".log", ".json", ".xml", ".html", ".md", ".yaml", ".yml"].includes(e)) return "text";
  return "file";
};

// ---- recording ----

const newId = () => Date.now().toString(36) + randomBytes(3).toString("hex");
const cut = (s: unknown, n: number) => (s === undefined || s === null ? undefined : String(s).slice(0, n));

// worktrees change rarely; the last list is kept so starting a run stays synchronous, and refreshed behind it
let worktrees: Worktree[] = [];
const refreshWorktrees = () =>
  listWorktrees(false)
    .then((w) => void (worktrees = w))
    // the last list stays; runs started meanwhile only miss their worktree
    .catch((e) => console.error("runs: listing worktrees", e));

// pushes to the app at most once a second per run while lines stream in
const pending = new Map<string, NodeJS.Timeout>();
function changed(id: string, now = false) {
  const push = () => {
    pending.delete(id);
    const r = getRun(id);
    if (r) broadcast({ type: "run", run: r });
  };
  if (now) {
    clearTimeout(pending.get(id));
    return push();
  }
  if (!pending.has(id)) pending.set(id, setTimeout(push, 1000));
}

export function startRun(input: RunStart, source: string): Run {
  const command = cut(input.command, 2000);
  const kind = input.kind && KINDS.includes(input.kind) ? input.kind : (command && kindOf(command)) || "other";
  const name = cut(input.name, 200) || (command ? command.slice(0, 80) : kind);
  // a hook's name is Claude's own description of the command, so a ticket it mentions isn't where it ran
  const named = source === "hook" ? undefined : name;
  const place = placeOf({ ...input, name: named }, worktrees);
  const now = Date.now();
  const r: Run = {
    id: newId(),
    kind,
    name,
    source: cut(source, 60)!,
    ticket: place.ticket,
    worktree: place.worktree,
    cwd: cut(input.cwd, 1000),
    command,
    status: "running",
    startedAt: input.startedAt ?? now,
    updatedAt: now,
    summary: {},
    artifacts: [],
    meta: { ...(input.meta ?? {}) },
  };
  save(r);
  emit("run.started", r);
  changed(r.id, true);
  // a worktree made since the last look still gets found
  if (!place.worktree && (input.cwd || input.branch))
    refreshWorktrees().then(() => {
      const again = placeOf({ ...input, name: named }, worktrees);
      const cur = getRun(r.id);
      if (cur && again.worktree) save({ ...cur, worktree: again.worktree, ticket: cur.ticket ?? again.ticket });
    });
  return r;
}

export function appendLog(id: string, lines: string[]) {
  if (!lines.length) return;
  const file = logFile(id);
  const text = lines.map((l) => String(l)).join("\n") + "\n";
  appendFileSync(file, text);
  // past the cap the oldest half goes, not what comes next: how a run ends (its result, why it failed) matters most,
  // and a live view that redraws itself can fill 2 MB long before then
  if (statSync(file).size > MAX_LOG) {
    const keep = tailOf(file, Number.MAX_SAFE_INTEGER, MAX_LOG / 2);
    writeFileSync(file, `[earlier output dropped, past 2 MB]\n${keep.join("\n")}\n`);
  }
}

// The last bytes of a file as lines, without reading a whole 2 MB log
function tailOf(file: string, maxLines: number, bytes = 256 * 1024) {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const len = Math.min(size, bytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (len < size) lines.shift();
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-maxLines);
}
export const outputTail = (id: string, n = 200) => tailOf(logFile(id), n).map(strip);
export const stepLines = (id: string) => tailOf(stepsFile(id), 20000, MAX_LOG);

// Only files from where the run ran, its own folder or the temp folder, so a request can't pull in any file at all
function addArtifact(r: Run, a: { path: string; name?: string; type?: string }): RunArtifact | undefined {
  const src = resolve(String(a.path ?? ""));
  const dir = filesDir(r.id);
  const allowed = [dir, tmpdir(), r.cwd, r.worktree].filter((d): d is string => !!d).map((d) => resolve(d));
  if (!allowed.some((d) => src === d || src.startsWith(d + sep))) return;
  if (!existsSync(src) || !statSync(src).isFile()) return;
  const name = (cut(a.name, 120) || basename(src)).replace(/[^\w.-]+/g, "-");
  mkdirSync(dir, { recursive: true });
  if (src !== join(dir, name)) copyFileSync(src, join(dir, name));
  const art: RunArtifact = { name, path: `${r.id}/${name}`, type: a.type && /^\w{1,20}$/.test(a.type) ? a.type : typeOf(name) };
  r.artifacts = [...r.artifacts.filter((x) => x.name !== name), art];
  return art;
}

// ---- cutting a video ----

// the original of a cut video, next to it and not listed, so every cut starts from the whole recording
export const originalOf = (id: string, name: string) => join(filesDir(id), `.original-${name}`);
const cutting = new Set<string>();

// Keeps start..end seconds of a run's video. It's encoded again rather than copied, so the cut lands on the exact
// frame and not on the keyframe before it.
export async function trimVideo(id: string, name: string, start: number, end: number) {
  const r = getRun(id);
  const a = r?.artifacts.find((x) => x.name === name && x.type === "video");
  if (!r || !a) throw Object.assign(new Error("no such video"), { status: 404 });
  if (r.status === "running") throw Object.assign(new Error("Wait for the run to end before cutting its video"), { status: 409 });
  if (!(Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end - start >= 0.5)) throw Object.assign(new Error("The end has to be at least half a second after the start"), { status: 400 });
  const key = `${id}/${name}`;
  if (cutting.has(key)) throw Object.assign(new Error("It's already being cut"), { status: 409 });
  cutting.add(key);
  try {
    const file = join(filesDir(id), name);
    const original = originalOf(id, name);
    if (!existsSync(original)) copyFileSync(file, original);
    const tmp = join(filesDir(id), `.cut-${name}`);
    await run("ffmpeg", ["-y", "-v", "error", "-ss", start.toFixed(3), "-i", original, "-t", (end - start).toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", tmp], { timeout: 15 * 60_000 }).catch((e: Error) => {
      rmSync(tmp, { force: true });
      throw Object.assign(new Error(/ENOENT/.test(e.message) ? "Cutting videos needs ffmpeg installed" : `ffmpeg couldn't cut it: ${e.message.split("\n").slice(-1)[0]}`), { status: 500 });
    });
    renameSync(tmp, file);
    const fresh = getRun(id)!;
    fresh.artifacts = fresh.artifacts.map((x) => (x.name === name ? { ...x, trimmed: { start: +start.toFixed(3), end: +end.toFixed(3), at: Date.now() } } : x));
    save(fresh);
    broadcast({ type: "run", run: fresh });
    return fresh;
  } finally {
    cutting.delete(key);
  }
}

// puts the whole recording back
export function restoreVideo(id: string, name: string) {
  const r = getRun(id);
  const a = r?.artifacts.find((x) => x.name === name && x.type === "video");
  const original = originalOf(id, name);
  if (!r || !a || !existsSync(original)) throw Object.assign(new Error("There's no original to put back"), { status: 404 });
  renameSync(original, join(filesDir(id), name));
  r.artifacts = r.artifacts.map((x) => (x.name === name ? { name: x.name, path: x.path, type: x.type } : x));
  save(r);
  broadcast({ type: "run", run: r });
  return r;
}

const ENDS: Record<string, RunStatus | undefined> = { done: undefined, failed: "fail", cancelled: "cancelled" };

// One event: output lines, raw step lines, progress, a phase, an error, the result.
export function appendRun(id: string, e: RunEvent): Run | undefined {
  const row = rowOf(id);
  if (!row) return;
  const r = toRun(row);
  // it was given up for dead after a quiet spell, but it's still going
  if (r.status === "fail" && r.meta.error === STOPPED && !(e.phase && Object.hasOwn(ENDS, e.phase))) Object.assign(r, { status: "running", endedAt: undefined, meta: { ...r.meta, error: undefined } });
  r.updatedAt = Date.now();
  if (Array.isArray(e.lines)) appendLog(id, e.lines.map((l) => String(l).slice(0, 4000)));
  if (Array.isArray(e.steps) && e.steps.length) {
    const size = existsSync(stepsFile(id)) ? statSync(stepsFile(id)).size : 0;
    if (size < MAX_LOG) appendFileSync(stepsFile(id), e.steps.map((l) => String(l).slice(0, 1000)).join("\n") + "\n");
  }
  if (typeof e.progress === "number" && Number.isFinite(e.progress)) r.meta.progress = Math.max(0, Math.min(1, e.progress));
  if (e.error) r.meta.error = cut(e.error, 1000);
  if (e.meta && typeof e.meta === "object") r.meta = { ...r.meta, ...e.meta };
  if (e.summary && typeof e.summary === "object") r.summary = { ...r.summary, ...e.summary };
  if (e.result && typeof e.result === "object") {
    const { status, file, ...rest } = e.result;
    if (status !== undefined && Number.isFinite(Number(status))) r.exitCode = Number(status);
    // a file the script put in the run's own folder, like a recorded video
    if (typeof file === "string" && /^[\w.-]+$/.test(file)) addArtifact(r, { path: join(filesDir(id), file) });
    for (const [k, v] of Object.entries(rest)) if (/^\w{1,40}$/.test(k) && v !== undefined) r.meta[k] = typeof v === "string" ? v.slice(0, 500) : v;
  }
  for (const a of Array.isArray(e.artifacts) ? e.artifacts.slice(0, 50) : []) addArtifact(r, a);
  if (e.phase && typeof e.phase === "string") {
    const phase = e.phase.slice(0, 30);
    if (Object.hasOwn(ENDS, phase)) {
      save(r);
      return finishRun(id, { status: ENDS[phase] });
    }
    if (phase === "rendering" && r.meta.phase !== "rendering") r.meta.progress = 0;
    r.meta.phase = phase;
  }
  save(r);
  changed(id);
  return r;
}

const STOPPED = "stopped reporting before it ended";

// Ends a run: no status means it passed when it exited 0 (or with no exit code at all) and failed otherwise.
export function finishRun(id: string, f: { status?: RunStatus; exitCode?: number; error?: string; endedAt?: number; quiet?: boolean } = {}): Run | undefined {
  const row = rowOf(id);
  if (!row) return;
  const r = toRun(row);
  if (f.exitCode !== undefined) r.exitCode = f.exitCode;
  if (f.error) r.meta.error = cut(f.error, 1000);
  r.status = f.status && STATUSES.includes(f.status) && f.status !== "running" ? f.status : r.exitCode === undefined || r.exitCode === 0 ? "pass" : "fail";
  r.endedAt = f.endedAt ?? Date.now();
  r.updatedAt = Date.now();
  if (r.meta.phase) r.meta.phase = r.status === "pass" ? "done" : r.status === "cancelled" ? "cancelled" : "failed";
  // kept, so the sidebar badge leaves it out too
  if (f.quiet) r.meta.quiet = true;
  r.summary = { ...countsOf(outputTail(id, 600)), ...r.summary };
  save(r);
  emit("run.done", r);
  // a pass makes the earlier failures' videos of the same thing redundant
  if (r.status === "pass") setImmediate(() => dropFailedVideos());
  changed(id, true);
  if (failureIsNews(r)) {
    const what = { unit: "Tests", lint: "Lint", typecheck: "Typecheck", audit: "Audit", e2e: "E2E run", proof: "Proof run", verify: "Checks", ci: "CI check", other: "Run" }[r.kind];
    const last = outputTail(id, 30).filter((l) => l.trim()).at(-1);
    const body = r.summary.failing?.[0] ? `Failing: ${r.summary.failing[0]}` : (r.meta.error ?? last ?? "");
    notify({ title: `${what} failed: ${r.name}`, body: body.slice(0, 200), link: `/runs/${r.id}`, kind: "run" });
  }
  return r;
}

export type RecordInput = RunStart & { status: RunStatus; exitCode?: number; endedAt?: number; output?: string; summary?: RunSummary; artifacts?: RunArtifact[] | { path: string; name?: string; type?: string }[]; quiet?: boolean };

// A run that's already over, in one go: a hook's command, a CI check, what Claude says it ran
export function recordRun(input: RecordInput, source: string): Run {
  const r = startRun(input, source);
  if (input.output) appendLog(r.id, input.output.split("\n"));
  if (input.summary || input.artifacts?.length) appendRun(r.id, { summary: input.summary, artifacts: input.artifacts as RunEvent["artifacts"] });
  return finishRun(r.id, { status: input.status, exitCode: input.exitCode, endedAt: input.endedAt, quiet: input.quiet })!;
}

// a script that was killed outright never says it ended; a terminal's run (whoever opened the terminal) and verify
// say nothing while they go, and end when their terminal or job does
function settle(r: Run) {
  if (r.status !== "running" || ["terminal", "verify"].includes(r.source) || r.meta.terminal || Date.now() - r.updatedAt < QUIET_MS) return r;
  return finishRun(r.id, { status: "fail", error: STOPPED, endedAt: r.updatedAt }) ?? r;
}

export function getRun(id: string) {
  const row = rowOf(id);
  return row ? toRun(row) : undefined;
}

export function listRuns(f: RunFilter = {}): Run[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.ticket) where.push("ticket = ?"), args.push(f.ticket);
  if (f.worktree) where.push("worktree = ?"), args.push(f.worktree);
  if (f.kind) where.push("kind = ?"), args.push(f.kind);
  if (f.status) where.push("status = ?"), args.push(f.status);
  if (f.since) where.push("started_at >= ?"), args.push(f.since);
  const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 1000);
  const rows = db.prepare(`select * from runs ${where.length ? `where ${where.join(" and ")}` : ""} order by started_at desc limit ${limit}`).all(...args) as Row[];
  return rows.map(toRun).map(settle);
}

export const settled = (id: string) => {
  const r = getRun(id);
  return r && settle(r);
};

export function deleteRun(id: string) {
  db.prepare("delete from runs where id = ?").run(id);
  for (const p of [logFile(id), stepsFile(id), filesDir(id), join(runsDir, `${id}.exit`)]) rmSync(p, { recursive: true, force: true });
}

// A failed or cancelled run's video helps only while you look into what went wrong, and a simulator's raw recording
// is large: it goes once a later run of the same thing in the same place passes, or after the hours Settings gives.
// The run itself stays, with a note of why its video went. 0 hours keeps them.
export function dropFailedVideos(hours = getSettings().runs.failedVideoHours, now = Date.now()) {
  if (!hours) return 0;
  const rows = db.prepare<[], Row>(`select * from runs where status in ('fail', 'cancelled') and artifacts like '%"video"%'`).all().map(toRun);
  const passedLater = db.prepare<[string, string, number], { one: number }>("select 1 as one from runs where name = ? and coalesce(worktree, '') = ? and status = 'pass' and started_at > ? limit 1");
  let n = 0;
  for (const r of rows) {
    const videos = r.artifacts.filter((a) => a.type === "video");
    if (!videos.length) continue;
    const passed = !!passedLater.get(r.name, r.worktree ?? "", r.startedAt);
    if (!passed && now - (r.endedAt ?? r.startedAt) < hours * 3600_000) continue;
    for (const v of videos) for (const f of [join(filesDir(r.id), v.name), originalOf(r.id, v.name)]) rmSync(f, { force: true });
    r.artifacts = r.artifacts.filter((a) => a.type !== "video");
    r.meta.videoDropped = passed ? "a later run of it passed" : `it failed more than ${hours} hours ago`;
    save(r);
    n++;
  }
  if (n) console.log(`runs: removed the videos of ${n} failed runs`);
  return n;
}

// Runs older than 90 days, or past the newest 3000, go; those of a ticket in the current sprint stay.
export function sweep(keep: Set<string>, now = Date.now()) {
  const old = db.prepare<[number], { id: string; ticket: string | null }>("select id, ticket from runs where started_at < ?").all(now - KEEP_DAYS * 864e5);
  const over = db.prepare<[number], { id: string; ticket: string | null }>("select id, ticket from runs order by started_at desc limit -1 offset ?").all(KEEP_RUNS);
  let n = 0;
  for (const r of [...old, ...over]) {
    if ((r.ticket && keep.has(r.ticket)) || !rowOf(r.id)) continue;
    deleteRun(r.id);
    n++;
  }
  return n;
}

// ---- where runs come from ----

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { command?: string; description?: string; run_in_background?: boolean };
  tool_response?: { stdout?: string; stderr?: string; interrupted?: boolean; backgroundTaskId?: string } | string;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}

// What Claude Code's PostToolUse and PostToolUseFailure hooks say about a Bash call, as a finished run, or undefined
// when the command isn't a run (or went to the background, where its output comes later and only to Claude).
export function fromHook(p: HookPayload, patterns?: Patterns, now = Date.now()): RecordInput | undefined {
  if (p.tool_name !== "Bash" || !p.tool_input?.command) return;
  const res = typeof p.tool_response === "object" ? p.tool_response : undefined;
  if (p.tool_input.run_in_background || res?.backgroundTaskId) return;
  const command = p.tool_input.command;
  const kind = kindOf(command, patterns);
  if (!kind) return;
  const failed = p.hook_event_name === "PostToolUseFailure";
  let status: RunStatus = "pass";
  let exitCode: number | undefined = 0;
  let output = "";
  if (failed) {
    // "Exit code 1\n<stdout and stderr>", or a bare message when it never ran
    const err = String(p.error ?? "");
    const code = err.match(/^Exit code (\d+)/);
    exitCode = code ? Number(code[1]) : undefined;
    status = p.is_interrupt ? "cancelled" : "fail";
    output = code ? err.slice(code[0].length).replace(/^\n/, "") : err;
  } else {
    output = typeof p.tool_response === "string" ? p.tool_response : [res?.stdout, res?.stderr].filter(Boolean).join("\n");
    if (res?.interrupted) (status = "cancelled"), (exitCode = undefined);
  }
  const ms = Number(p.duration_ms);
  return {
    kind,
    name: (p.tool_input.description || command).slice(0, 120),
    command,
    cwd: p.cwd,
    status,
    exitCode,
    output,
    startedAt: Number.isFinite(ms) && ms > 0 ? now - ms : now,
    endedAt: now,
    meta: { session: p.session_id, toolUseId: p.tool_use_id },
  };
}

// The same tool call reported twice (a retried hook) is one run
export function recordHook(p: HookPayload) {
  const input = fromHook(p);
  if (!input) return;
  if (p.tool_use_id && db.prepare("select 1 from runs where source = 'hook' and json_extract(meta, '$.toolUseId') = ?").get(p.tool_use_id)) return;
  // a command that reported its own run while it ran (`cockpit run`, a script on the runs API) is already there
  const own = db
    .prepare<[number, number], { command: string | null }>("select command from runs where source != 'hook' and started_at >= ? and started_at <= ?")
    .all((input.startedAt ?? Date.now()) - 5000, input.endedAt ?? Date.now());
  if (own.some((r) => r.command && input.command?.includes(r.command))) return;
  return recordRun(input, "hook");
}

const shq = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

// A terminal whose command is recorded as a run: its output and exit code land on the run when it exits.
// run.command is what to record when the terminal wraps it, say in a login shell, so a rerun doesn't wrap it twice.
export function terminalRun(t: { cwd: string; title?: string; command?: string; args?: string[]; session?: string; beside?: boolean; run: { kind?: RunKind; name?: string; ticket?: string; command?: string } }, source = "terminal") {
  const command = t.run.command ?? (t.command ? [t.command, ...(t.args ?? [])].map((a) => (/^[\w./:@+=,-]+$/.test(a) ? a : shq(a))).join(" ") : undefined);
  const r = startRun({ kind: t.run.kind, name: t.run.name ?? t.title, ticket: t.run.ticket, cwd: t.cwd, command }, source);
  const term = spawnTerm({ cwd: t.cwd, title: t.title, command: t.command, args: t.args, session: t.session, beside: t.beside, run: r.id });
  appendRun(r.id, { meta: { terminal: term.id } });
  return { ...term, runId: r.id };
}

// Runs the same command again, in a terminal, as a new run
export function rerun(id: string) {
  const r = getRun(id);
  if (!r) throw Object.assign(new Error("no such run"), { status: 404 });
  if (!r.command) throw Object.assign(new Error("this run has no command to run again"), { status: 400 });
  const cwd = r.cwd && existsSync(r.cwd) ? r.cwd : r.worktree && existsSync(r.worktree) ? r.worktree : undefined;
  if (!cwd) throw Object.assign(new Error("the folder it ran in is gone"), { status: 400 });
  // a script that reports its own runs says how to start it again (meta.rerun), and records the new run itself;
  // a run started some other way takes it from an earlier run of the same thing that has one
  const again = (typeof r.meta.rerun === "string" && r.meta.rerun) || db.prepare<[string, string | null], { rerun: string }>("select json_extract(meta, '$.rerun') as rerun from runs where name = ? and cwd is ? and json_extract(meta, '$.rerun') is not null order by started_at desc limit 1").get(r.name, r.cwd ?? null)?.rerun;
  if (again) return { ...spawnTerm({ cwd, title: r.name, command: "bash", args: ["-lc", again], beside: true }), runId: undefined };
  return terminalRun({ cwd, title: r.name, command: "bash", args: ["-lc", r.command], beside: true, run: { kind: r.kind, name: r.name, ticket: r.ticket, command: r.command } });
}

// A terminal's scrollback as plain lines: no runs of blank lines from redraws, no tmux "[exited]"
export function screenLines(out: string) {
  const lines = strip(out)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l, i, all) => l !== "[exited]" && (l || (i > 0 && all[i - 1])));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines;
}

export function startRuns() {
  refreshWorktrees();
  onEvent((event, data) => {
    if (event === "worktree.created" || event === "worktree.removed") refreshWorktrees();
    if (event !== "terminal.exited") return;
    const d = data as { id: string; code: number; run?: string; killed?: boolean; output?: string };
    if (!d.run) return;
    if (d.output) appendLog(d.run, screenLines(d.output));
    if (getRun(d.run)?.status === "running") finishRun(d.run, d.killed ? { status: "cancelled", error: "its terminal was closed" } : { exitCode: d.code });
  });
  // verify jobs die with the server; a terminal's run ends when its terminal does, which may have happened while
  // cockpit was down (terminals that kept running in tmux are reattached first)
  // hook runs that took a ticket from their description before that stopped: only a worktree gives one a ticket
  db.prepare("update runs set ticket = null where source = 'hook' and worktree is null and ticket is not null").run();
  setTimeout(() => {
    const live = new Set(listTerms().map((t) => t.id));
    for (const r of db.prepare<[], Row>("select * from runs where status = 'running' and (source in ('verify', 'terminal') or json_extract(meta, '$.terminal') is not null)").all().map(toRun)) {
      if (r.meta.terminal && live.has(r.meta.terminal)) continue;
      const code = existsSync(join(runsDir, `${r.id}.exit`)) ? Number(readFileSync(join(runsDir, `${r.id}.exit`), "utf8").trim()) : NaN;
      finishRun(r.id, Number.isFinite(code) ? { exitCode: code } : { status: "cancelled", error: "cockpit restarted while it ran" });
    }
  }, 5000);
  // after the tracker plugin has had time to load, so this sprint's tickets are known
  const clean = async () => {
    // no tracker means nothing to keep; a tracker that fails means we can't tell, so this sweep waits for the next
    const tickets = await sprintTickets(undefined, false, 6 * 3600_000, "team");
    const n = sweep(new Set(tickets.map((t) => t.key)));
    if (n) console.log(`runs: removed ${n} old runs`);
  };
  setTimeout(() => void clean().catch((e) => console.error("runs sweep", e)), 60_000);
  setTimeout(() => dropFailedVideos(), 30_000);
  setInterval(() => dropFailedVideos(), 3600_000).unref();
  setInterval(() => void clean().catch((e) => console.error("runs sweep", e)), 24 * 3600_000).unref();
}
