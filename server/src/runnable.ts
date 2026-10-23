// "Run something": what can run in a worktree (the verify command, every package.json script in it, and what plugins
// offer) and starting one of them as a run.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { RunKind, RunOptionList, RunOptionStarted, RunTarget, Worktree } from "@cockpit/shared";
import { config } from "./config.ts";
import { pluginRunOptions, startPluginOption } from "./plugins.ts";
import { kindOf, listRuns, terminalRun } from "./runs.ts";
import { fill } from "./util.ts";
import { runVerify } from "./verify.ts";
import { listWorktrees } from "./worktrees.ts";

const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

// ---- package.json scripts ----

// build output and dependencies have package.json files of their own that nobody runs; dot folders are tool caches
const SKIP = new Set(["node_modules", ".git", "dist", "build"]);
const DEPTH = 4;
// what the package manager runs by itself around installing and publishing
const LIFECYCLE = /^(pre|post)?(install|uninstall|prepare|prepublish|prepublishOnly|prepack|postpack|publish|version|restart|shrinkwrap)$/;

export interface Script {
  dir: string;
  // from the worktree's root, "." for the root itself
  rel: string;
  name: string;
  // what the script runs, from package.json
  body: string;
  runner: string;
}

const readJson = (file: string): Record<string, any> | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

// The package manager a package uses: the nearest packageManager field or lockfile, looking up as far as the
// worktree's root; npm when nothing says, since it comes with node
export function runnerFor(dir: string, root: string) {
  for (let d = dir; ; d = dirname(d)) {
    const pm = readJson(join(d, "package.json"))?.packageManager;
    if (typeof pm === "string" && /^(pnpm|yarn|npm|bun)@/.test(pm)) return pm.split("@")[0];
    if (existsSync(join(d, "pnpm-lock.yaml")) || existsSync(join(d, "pnpm-workspace.yaml"))) return "pnpm";
    if (existsSync(join(d, "yarn.lock"))) return "yarn";
    if (existsSync(join(d, "bun.lock")) || existsSync(join(d, "bun.lockb"))) return "bun";
    if (existsSync(join(d, "package-lock.json"))) return "npm";
    if (d === root || !d.startsWith(root + "/")) return "npm";
  }
}

// Every script of every package.json under root, a few folders deep. A pre or post hook of another script runs
// with it, so it isn't listed on its own.
export function scriptsIn(root: string, depth = DEPTH): Script[] {
  const out: Script[] = [];
  const walk = (dir: string, level: number) => {
    const scripts = readJson(join(dir, "package.json"))?.scripts;
    if (scripts && typeof scripts === "object") {
      const runner = runnerFor(dir, root);
      const names = Object.keys(scripts);
      for (const [name, body] of Object.entries(scripts)) {
        if (typeof body !== "string" || LIFECYCLE.test(name)) continue;
        const hook = name.match(/^(?:pre|post)(.+)$/);
        if (hook && names.includes(hook[1])) continue;
        out.push({ dir, rel: relative(root, dir) || ".", name, body, runner });
      }
    }
    if (level >= depth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // symlinked folders aren't followed, so a link back up can't loop
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), level + 1);
  };
  walk(root, 0);
  return out;
}

const shq = (a: string) => (/^[\w./:@+=,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
export const scriptCommand = (s: Pick<Script, "runner" | "name">) => `${s.runner} run ${shq(s.name)}`;
// by its name first ("test:e2e"), then by what it runs ("vitest run"), else it's other
export const scriptKind = (s: Pick<Script, "runner" | "name" | "body">): RunKind => kindOf(scriptCommand(s)) ?? kindOf(s.body) ?? "other";

// ---- the list for a worktree ----

type Starter = () => Promise<RunOptionStarted>;
interface Built {
  list: RunOptionList;
  starts: Map<string, Starter>;
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; built: Promise<Built> }>();

export interface Deps {
  worktrees?: () => Promise<Worktree[]>;
}

// Only a worktree cockpit knows (or its main checkout), so a request can't start things in any folder at all
async function targetOf(path: string, deps: Deps): Promise<RunTarget> {
  if (!path) throw bad("say which worktree");
  const wt = (await (deps.worktrees ?? (() => listWorktrees(false)))()).find((w) => w.path === path);
  if (!wt) throw bad("that isn't a worktree cockpit knows");
  if (!existsSync(wt.path)) throw bad("that worktree's folder is gone");
  return { path: wt.path, name: wt.name, branch: wt.branch, ticket: wt.ticket, main: wt.main };
}

async function build(wt: RunTarget): Promise<Built> {
  const options: RunOptionList["options"] = [];
  const starts = new Map<string, Starter>();
  const errors: RunOptionList["errors"] = [];
  const verify = config.repo.verifyCommand;
  if (verify) {
    // the command as it will run here, the way verify fills it in
    const detail = fill(verify, { path: wt.path, repo: config.repo.path, name: wt.path.split("/").slice(-2).join("/") });
    options.push({ id: "verify", kind: "verify", label: "Verify", detail, group: "Checks", source: "cockpit" });
    starts.set("verify", async () => {
      const job = await runVerify(wt.path, true);
      if (job) return { runId: job.runId };
      // forced, so the only way it doesn't start is that it's already going
      const now = listRuns({ worktree: wt.path, kind: "verify", status: "running", limit: 1 })[0];
      return now ? { runId: now.id } : { note: "Verify is already running in this worktree." };
    });
  }
  // plugins' options before the scripts: there are few of them, picked for this worktree, and a big repo has hundreds of scripts
  for (const p of await pluginRunOptions(wt)) {
    if (p.error) errors.push({ source: p.name, error: p.error });
    for (const o of p.options) {
      if (!o || typeof o.id !== "string" || typeof o.label !== "string") continue;
      const id = `plugin:${p.plugin}:${o.id}`;
      if (starts.has(id)) continue;
      options.push({ id, kind: o.kind ?? "other", label: o.label, detail: o.detail, group: o.group || p.name, source: p.name });
      starts.set(id, () => startPluginOption(p.plugin, p.entry, o.id, wt));
    }
  }
  for (const s of scriptsIn(wt.path)) {
    const id = `script:${s.rel}:${s.name}`;
    const command = scriptCommand(s);
    const kind = scriptKind(s);
    const where = s.rel === "." ? "" : s.rel;
    options.push({ id, kind, label: s.name, detail: `${command} · ${s.body}`, group: where ? `${where}/package.json` : "package.json", source: "cockpit" });
    // in a login shell, so the package manager is on PATH the way it is in your own terminal
    starts.set(id, async () => {
      const t = terminalRun({ cwd: s.dir, title: `${s.name}${where ? ` · ${where}` : ""}`, command: "bash", args: ["-lc", command], beside: true, run: { kind, name: `${s.name}${where ? ` (${where})` : ""}`, ticket: wt.ticket, command } }, "manual");
      return { runId: t.runId, term: t.id };
    });
  }
  return { list: { worktree: wt.path, options, errors }, starts };
}

function builtFor(wt: RunTarget, force = false) {
  const hit = cache.get(wt.path);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.built;
  const built = build(wt);
  cache.set(wt.path, { at: Date.now(), built });
  // a failed list isn't kept, so the next look tries again
  built.catch(() => cache.get(wt.path)?.built === built && cache.delete(wt.path));
  return built;
}

export async function runOptions(path: string, opts: Deps & { force?: boolean } = {}) {
  return (await builtFor(await targetOf(path, opts), opts.force)).list;
}

// Starts one of the worktree's options, only by an id its list has; one the cached list doesn't know gets a fresh
// look first, in case the worktree gained a script since
export async function startOption(path: string, id: string, deps: Deps = {}) {
  if (!id) throw bad("say what to run");
  const wt = await targetOf(path, deps);
  const start = (await builtFor(wt)).starts.get(id) ?? (await builtFor(wt, true)).starts.get(id);
  if (!start) throw bad("that isn't something this worktree can run");
  return start();
}
