// Installing a plugin from a git link. It's cloned to a staging folder first and read without running anything:
// its manifest, the plugin API it needs, the settings, secrets, commands and skills it asks for, and which parts
// of cockpit's plugin API its code calls. Only after you accept is it copied into your plugins folder, pinned to
// that commit and off until you turn it on. Updates clone again and show what changed the same way.
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { Manifest } from "@cockpit/shared";
import { paths } from "./config.ts";
import { listPlugins, loadAll, parseManifest, SOURCE_FILE, type Source, sourceOf, updatePlugin, userDir } from "./plugins.ts";
import { run } from "./util.ts";

const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });

const stagingDir = join(paths.data, "plugin-staging");

// https and ssh links, and owner/name for GitHub; nothing that git would read as an option or a local path
export function gitUrl(input: string) {
  const s = input.trim().replace(/\/+$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}.git`;
  if (/^https:\/\/[\w.-]+(:\d+)?\/[\w./~-]+$/.test(s)) return s;
  if (/^git@[\w.-]+:[\w./~-]+$/.test(s)) return s;
  throw bad("Paste an https or ssh git link, or owner/name for a GitHub repo");
}

// a folder inside the repo, never above it
export function subPath(p?: string) {
  const s = (p ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!s) return undefined;
  const n = normalize(s);
  if (n.startsWith("..") || n.split(sep).includes("..")) throw bad("The folder has to be inside the repo");
  return n;
}

// The parts of the plugin API its code calls, so you know what it does before turning it on
const USES: [RegExp, string][] = [
  [/\bk\.run\(/, "runs commands on this machine"],
  [/\bk\.(terminal|claude)\(/, "opens terminals and starts Claude"],
  [/\bk\.sendToSession\(/, "types into your Claude sessions"],
  [/\bk\.task\(/, "queues tasks (worktrees and branches)"],
  [/\bk\.job\(/, "runs background jobs"],
  [/\bk\.route\(/, "adds API routes"],
  [/\bk\.screen\(/, "adds screens"],
  [/\bk\.(tracker|codeHost|reviewSource)\(/, "plugs in a tracker, code host or review queue"],
  [/\bk\.access\(/, "decides who can reach cockpit from other machines"],
  [/\bk\.on\(/, "listens to cockpit's events"],
  [/\bk\.notify\(/, "sends notifications"],
  [/\b(fetch|https?\.request)\(/, "makes network requests"],
  [/\bnode:child_process\b|\bchild_process\b/, "starts processes directly"],
  [/\bnode:fs\b|\bfrom ["']fs["']/, "reads and writes files"],
];

function codeFiles(dir: string, depth = 4): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory() && level < depth) walk(p, level + 1);
      else if (e.isFile() && /\.(ts|js|mjs|cjs)$/.test(e.name) && statSync(p).size < 2_000_000) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

export function usesOf(dir: string) {
  const text = codeFiles(dir).map((f) => readFileSync(f, "utf8")).join("\n");
  return USES.filter(([re]) => re.test(text)).map(([, what]) => what);
}

// what a manifest asks of you
export function asks(m: Manifest) {
  return {
    settings: (m.settings ?? []).filter((s) => s.type !== "secret").map((s) => s.label),
    secrets: (m.settings ?? []).filter((s) => s.type === "secret").map((s) => `${s.label}${s.env ? ` (as ${s.env})` : ""}`),
    commands: (m.requires ?? []).map((r) => r.name),
    skills: (m.skills ?? []).map((s) => s.name),
  };
}

// what an update changes in what it asks for
export function askDiff(before: ReturnType<typeof asks>, after: ReturnType<typeof asks>) {
  const out: string[] = [];
  for (const k of ["settings", "secrets", "commands", "skills"] as const) {
    const added = after[k].filter((x) => !before[k].includes(x));
    const gone = before[k].filter((x) => !after[k].includes(x));
    if (added.length) out.push(`new ${k}: ${added.join(", ")}`);
    if (gone.length) out.push(`no longer ${k}: ${gone.join(", ")}`);
  }
  return out;
}

interface Staged {
  dir: string;
  root: string;
  source: Omit<Source, "installedAt">;
  manifest: Manifest;
  at: number;
}
const staged = new Map<string, Staged>();

function sweep() {
  for (const [token, s] of staged) {
    if (Date.now() - s.at < 30 * 60_000) continue;
    rmSync(s.root, { recursive: true, force: true });
    staged.delete(token);
  }
}

// Clones and reads it. Nothing of the plugin runs here: no install scripts, no code.
export async function preview(input: { url: string; ref?: string; path?: string }) {
  sweep();
  const url = gitUrl(input.url);
  const ref = input.ref?.trim() || undefined;
  if (ref && !/^[\w./-]+$/.test(ref)) throw bad("That isn't a branch or tag name");
  const path = subPath(input.path);
  mkdirSync(stagingDir, { recursive: true });
  const root = join(stagingDir, randomUUID().slice(0, 12));
  try {
    // a little history, so an update can list the commits since the installed one
    await run("git", ["clone", "--depth", "50", ...(ref ? ["--branch", ref] : []), "--", url, root], { timeout: 120_000, env: { GIT_TERMINAL_PROMPT: "0" } });
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw bad(`Couldn't clone it: ${(e as Error).message.split("\n").slice(-1)[0]}`);
  }
  const dir = path ? join(root, path) : root;
  const fail = (msg: string) => {
    rmSync(root, { recursive: true, force: true });
    return bad(msg);
  };
  if (!existsSync(join(dir, "plugin.json"))) throw fail(path ? `There's no plugin.json in ${path}` : "There's no plugin.json at the top of the repo. If the plugin is in a folder, say which");
  let manifest: Manifest;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")));
  } catch (e) {
    throw fail(`Its plugin.json isn't one cockpit can use: ${(e as Error).message}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) throw fail(`Its id "${manifest.id}" can't be a folder name here`);
  const commit = (await run("git", ["-C", root, "rev-parse", "HEAD"])).trim();

  const current = listPlugins().plugins.find((p) => p.manifest.id === manifest.id);
  const installed = current && !current.bundled ? sourceOf(current.dir) : undefined;
  // one you made yourself in the plugins folder is never overwritten from here
  if (current && !current.bundled && !installed) throw fail(`You already have a plugin called "${manifest.id}" in your plugins folder that wasn't installed from a link, so it won't be replaced`);
  let commits: string[] | undefined;
  if (installed && installed.commit !== commit) commits = (await run("git", ["-C", root, "log", "--format=%h %s", `${installed.commit}..${commit}`]).catch(() => "")).trim().split("\n").filter(Boolean);
  const before = current ? asks(current.manifest) : undefined;

  const token = randomUUID();
  staged.set(token, { dir, root, source: { url, ref, path, commit }, manifest, at: Date.now() });
  return {
    token,
    manifest,
    commit,
    hasCode: ["server.ts", "server.js", "server.mjs"].some((f) => existsSync(join(dir, f))),
    uses: usesOf(dir),
    asks: asks(manifest),
    // what's there now: a bundled one it would replace, or the installed one it updates
    replaces: current ? { bundled: current.bundled, version: current.manifest.version, commit: installed?.commit, on: current.on } : undefined,
    upToDate: !!installed && installed.commit === commit,
    commits,
    changes: before ? askDiff(before, asks(manifest)) : undefined,
  };
}

export async function install(token: string) {
  const s = staged.get(token);
  if (!s) throw bad("That preview has expired. Look it up again");
  staged.delete(token);
  const target = join(userDir, s.manifest.id);
  const old = existsSync(target) ? sourceOf(target) : undefined;
  if (existsSync(target) && !old) throw bad(`"${s.manifest.id}" in your plugins folder wasn't installed from a link, so it won't be replaced`);
  const wasOn = listPlugins().plugins.find((p) => p.manifest.id === s.manifest.id && !p.bundled)?.on;
  try {
    // off while the files change, so it never runs half copied
    if (wasOn) await updatePlugin(s.manifest.id, { on: false });
    rmSync(target, { recursive: true, force: true });
    cpSync(s.dir, target, { recursive: true, filter: (src) => !src.split(sep).includes(".git") });
    const source: Source = { ...s.source, installedAt: Date.now() };
    writeFileSync(join(target, SOURCE_FILE), JSON.stringify(source, null, 2));
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
  await loadAll();
  // an update keeps it on when it was; a new one starts off
  if (wasOn) await updatePlugin(s.manifest.id, { on: true });
  return { id: s.manifest.id, on: !!wasOn, updated: !!old };
}

export async function uninstall(id: string) {
  const p = listPlugins().plugins.find((x) => x.manifest.id === id && !x.bundled);
  if (!p || !sourceOf(p.dir)) throw bad("Only plugins installed from a link can be removed here");
  if (p.on) await updatePlugin(id, { on: false });
  rmSync(p.dir, { recursive: true, force: true });
  await loadAll();
  return { ok: true };
}

// a fresh look at an installed plugin's link, for its Update button
export function updatePreview(id: string) {
  const p = listPlugins().plugins.find((x) => x.manifest.id === id && !x.bundled);
  const src = p && sourceOf(p.dir);
  if (!src) throw bad("It wasn't installed from a link");
  return preview({ url: src.url, ref: src.ref, path: src.path });
}
