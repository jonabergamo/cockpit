// `cockpit run --record`: a video of a run, for a PR or a ticket. The command's browser opens on a virtual screen
// (Xvfb), the run's output shows live on a second one, ffmpeg records both, and once the command ends the two go
// side by side in one video kept with the run: the browser cut to its window, the output next to it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { config } from "./config.ts";
import { onEvent } from "./events.ts";
import { appendRun, filesDir, getRun } from "./runs.ts";
import { slugify } from "./util.ts";

interface Screen {
  n: number;
  w: number;
  h: number;
  xvfb: ChildProcess;
  grab?: ChildProcess;
  file: string;
}

interface Recording {
  id: string;
  dir: string;
  app: Screen;
  term: Screen;
  browser: ChildProcess;
  startedAt: number;
  stopping?: Promise<{ file?: string; error?: string }>;
}

const recordings = new Map<string, Recording>();
const TERM_W = 720;
const BG = "0x0d1117";

const onPath = (bin: string) => (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));

// the Chromium the output shows in: the one set in config, one on the PATH, else the newest Playwright installed
export function terminalBrowser() {
  if (config.record.browser) return existsSync(config.record.browser) || onPath(config.record.browser) ? config.record.browser : undefined;
  for (const b of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) if (onPath(b)) return b;
  const cache = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return;
  // newest install first: the build numbers changed scheme over the years, so they don't sort
  const builds = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => statSync(join(cache, b)).mtimeMs - statSync(join(cache, a)).mtimeMs);
  // today's builds are in chrome-linux64; chrome-linux is from years back
  for (const sub of ["chrome-linux64", "chrome-linux"])
    for (const d of builds) {
      const bin = join(cache, d, sub, "chrome");
      if (existsSync(bin)) return bin;
    }
}

// what's missing for a recording on this machine, empty when it can record
export function recordMissing() {
  if (process.platform !== "linux") return ["Linux (the virtual screen is Xvfb)"];
  return [...(onPath("Xvfb") ? [] : ["Xvfb"]), ...(onPath("ffmpeg") ? [] : ["ffmpeg"]), ...(terminalBrowser() ? [] : ["Chromium (set record.browser, or install Playwright's)"])];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const taken = (n: number) => existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`) || [...recordings.values()].some((r) => r.app.n === n || r.term.n === n);

async function screen(w: number, h: number, file: string): Promise<Screen> {
  let n = 90;
  while (taken(n)) n++;
  const xvfb = spawn("Xvfb", [`:${n}`, "-screen", "0", `${w}x${h}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
  for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
  if (!existsSync(`/tmp/.X11-unix/X${n}`)) {
    xvfb.kill();
    throw new Error(`Xvfb didn't start on :${n}`);
  }
  return { n, w, h, xvfb, file };
}

// light on the CPU while the tests run; the video is encoded properly once they're done
const grab = (s: Screen) => spawn("ffmpeg", ["-y", "-v", "error", "-f", "x11grab", "-draw_mouse", "0", "-video_size", `${s.w}x${s.h}`, "-framerate", "25", "-i", `:${s.n}`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p", s.file], { stdio: ["pipe", "ignore", "ignore"] });

const ended = (p: ChildProcess) => new Promise<void>((done) => (p.exitCode !== null || p.signalCode !== null ? done() : p.once("exit", () => done())));

async function end(p: ChildProcess | undefined, ms = 15_000) {
  if (!p) return;
  // q is how ffmpeg finishes its file properly; anything else just stops
  if (p.stdin?.writable) p.stdin.end("q");
  else p.kill("SIGTERM");
  const t = setTimeout(() => p.kill("SIGKILL"), ms);
  await ended(p);
  clearTimeout(t);
}

// Starts recording for a run; the command then runs with DISPLAY set to what this returns
export async function startRecording(id: string, size = config.record.screen) {
  const missing = recordMissing();
  if (missing.length) throw new Error(`can't record on this machine, it needs ${missing.join(", ")}`);
  if (recordings.has(id)) throw new Error("this run is being recorded already");
  const [w, h] = size.split("x").map(Number);
  const dir = join(filesDir(id), ".recording");
  mkdirSync(dir, { recursive: true });
  const app = await screen(w, h, join(dir, "screen.mp4"));
  let term: Screen;
  try {
    term = await screen(TERM_W, h, join(dir, "output.mp4"));
  } catch (e) {
    app.xvfb.kill();
    throw e;
  }
  // only ever cockpit's own page on this machine, so without the sandbox, which many distros block (Playwright
  // turns it off too)
  const browser = spawn(
    terminalBrowser()!,
    [`--app=http://127.0.0.1:${config.port}/api/runs/${id}/terminal`, "--kiosk", `--window-size=${TERM_W},${h}`, "--window-position=0,0", `--user-data-dir=${join(dir, "chromium")}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox", "--test-type", "--disable-infobars"],
    { stdio: "ignore", env: { ...process.env, DISPLAY: `:${term.n}` } },
  );
  const r: Recording = { id, dir, app, term, browser, startedAt: Date.now() };
  recordings.set(id, r);
  // the output page draws before the recording starts, so the video doesn't open on a blank pane
  await sleep(1500);
  app.grab = grab(app);
  term.grab = grab(term);
  r.startedAt = Date.now();
  return { display: `:${app.n}` };
}

async function stopScreens(r: Recording) {
  await Promise.all([end(r.app.grab), end(r.term.grab)]);
  r.browser.kill();
  await end(r.browser, 3000);
  r.app.xvfb.kill();
  r.term.xvfb.kill();
}

function ffmpeg(args: string[], onLine?: (l: string) => void) {
  return new Promise<string>((done, fail) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
      const lines = out.split("\n");
      out = lines.pop()!;
      lines.forEach((l) => onLine?.(l));
    });
    p.stderr.on("data", (d) => (err = (err + d).slice(-200_000)));
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? done(err) : fail(new Error(err.trim().split("\n").slice(-3).join(" ") || `ffmpeg exited ${code}`))));
  });
}

// the box the browser's window was in, from what wasn't black on the screen over the whole run
export async function contentBox(file: string, w: number, h: number) {
  const log = await ffmpeg(["-hide_banner", "-i", file, "-vf", "fps=2,cropdetect=limit=16:round=2:reset=0", "-f", "null", "-"]);
  const m = [...log.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].at(-1);
  if (!m) return;
  const [cw, ch, x, y] = m.slice(1).map(Number);
  // nothing (or next to nothing) was ever on screen: the browser ran headless
  if (cw < 200 || ch < 150) return;
  return { w: Math.min(cw, w - x), h: Math.min(ch, h - y), x, y };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

// The two recordings side by side on a dark background, both the same height; just the output when the browser
// never showed on the screen
export function layout(box: { w: number; h: number; x: number; y: number } | undefined, height: number) {
  const pad = 32;
  const gap = 24;
  const term = `[1:v]scale=-2:${height}[t]`;
  if (!box) return `${term};[t]pad=iw+${pad * 2}:ih+${pad * 2}:${pad}:${pad}:color=${BG}[v]`;
  return [`[0:v]crop=${even(box.w)}:${even(box.h)}:${box.x}:${box.y},scale=-2:${height},pad=iw+${gap}:ih:0:0:color=${BG}[a]`, term, `[a][t]hstack=inputs=2:shortest=1,pad=iw+${pad * 2}:ih+${pad * 2}:${pad}:${pad}:color=${BG}[v]`].join(";");
}

async function render(r: Recording, out: string) {
  const box = await contentBox(r.app.file, r.app.w, r.app.h).catch(() => undefined);
  const height = even(Math.min(r.app.h, 1000));
  const secs = Math.max(1, (Date.now() - r.startedAt) / 1000);
  await ffmpeg(
    ["-y", "-v", "error", "-i", r.app.file, "-i", r.term.file, "-filter_complex", layout(box, height), "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out],
    (l) => {
      const us = l.match(/^out_time_us=(\d+)/)?.[1];
      if (us) appendRun(r.id, { progress: Math.min(1, Number(us) / 1e6 / secs) });
    },
  );
  return box ? undefined : "The browser never showed on the screen, so the video only has the output. Run it headed (Playwright: --headed).";
}

// Ends a run's recording: stops the screens, makes the video and ends the run with the command's exit code
export function stopRecording(id: string, f: { status: number; cancelled?: boolean }) {
  const r = recordings.get(id);
  if (!r) return Promise.resolve({ error: "this run isn't being recorded" });
  if (r.stopping) return r.stopping;
  r.stopping = (async () => {
    appendRun(id, { result: { status: f.status }, phase: "stopping" });
    // the output page reads the log a moment behind, so its last lines get on the video too
    await sleep(1500);
    await stopScreens(r);
    const run = getRun(id);
    const file = `${slugify(run?.name ?? "", 60) || "recording"}.mp4`;
    try {
      if (f.cancelled) return {};
      appendRun(id, { phase: "rendering" });
      const note = await render(r, join(filesDir(id), file));
      appendRun(id, { result: { file, ...(note ? { note } : {}) } });
      return { file };
    } catch (e) {
      const error = `Couldn't make the video: ${(e as Error).message}`;
      // what the screen showed is still worth keeping
      const raw = `${slugify(run?.name ?? "", 60) || "recording"}-screen.mp4`;
      try {
        if (existsSync(r.app.file) && statSync(r.app.file).size) {
          await ffmpeg(["-y", "-v", "error", "-i", r.app.file, "-c", "copy", "-movflags", "+faststart", join(filesDir(id), raw)]);
          appendRun(id, { result: { file: raw } });
        }
      } catch {}
      appendRun(id, { error });
      return { error };
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
      recordings.delete(id);
      appendRun(id, { phase: f.cancelled ? "cancelled" : f.status === 0 ? "done" : "failed" });
    }
  })();
  return r.stopping;
}

// a run that ended without saying (its command was killed, it stopped reporting) leaves nothing running behind
export function startRecordings() {
  onEvent((event, data) => {
    const r = event === "run.done" ? recordings.get((data as { id: string }).id) : undefined;
    if (!r || r.stopping) return;
    r.stopping = stopScreens(r).then(() => {
      rmSync(r.dir, { recursive: true, force: true });
      recordings.delete(r.id);
      return { error: "the run ended before its recording was stopped" };
    });
  });
  const quit = () => {
    for (const r of recordings.values()) for (const p of [r.app.grab, r.term.grab, r.browser, r.app.xvfb, r.term.xvfb]) p?.kill("SIGKILL");
  };
  process.once("exit", quit);
}
