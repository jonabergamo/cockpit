import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { watch } from "chokidar";
import { z } from "zod";
import { PLUGIN_API, type AccessProvider, type Cockpit, type CodeHost, type Manifest, type PluginEvent, type PluginInfo, type PluginState, type RouteRequest, type ScreenInfo, type SettingValue, type Theme, type Tracker } from "@cockpit/shared";
import { config, paths } from "./config.ts";
import { cached } from "./db.ts";
import { onEvent } from "./events.ts";
import { broadcast } from "./hub.ts";
import { notify } from "./notify.ts";
import { listTerms, spawnTerm } from "./pty.ts";
import { listSessions } from "./claude/sessions.ts";
import { getSettings, readRow, writeRow } from "./settings.ts";
import { run, setKeyPattern, ticketOf } from "./util.ts";

// Plugins are folders with a plugin.json, from plugins/ in the repo (bundled) and from pluginsDir (yours).
// The manifest is read without running anything, so a broken plugin still shows up with its error.
// A plugin may have a server.ts with `export default function setup(k)`, and themes/*.json; either is optional.
export const bundledDir = join(paths.root, "plugins");
export const userDir = config.pluginsDir || join(paths.data, "plugins");

const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "a colour like #1c222c");
const themeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  scheme: z.enum(["dark", "light"]),
  ui: z.object({ ground: hex, panel: hex, raised: hex, ink: hex, muted: hex, faint: hex, line: hex, accent: hex, amber: hex, green: hex, red: hex }),
  ansi: z.array(hex).length(16),
});

const settingSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  label: z.string(),
  type: z.enum(["text", "secret", "bool", "choice", "number", "list", "json"]),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.record(z.string(), z.unknown())]).optional(),
  choices: z.array(z.string()).optional(),
  help: z.string().optional(),
  env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
});

const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, numbers and dashes"),
  name: z.string().min(1),
  version: z.string().default("0.0.0"),
  api: z.number().int().max(PLUGIN_API, `this cockpit supports plugin api ${PLUGIN_API}`),
  description: z.string().optional(),
  author: z.string().optional(),
  homepage: z.string().optional(),
  defaultOn: z.boolean().optional(),
  settings: z.array(settingSchema).default([]),
  skills: z.array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), required: z.boolean().optional() })).default([]),
  requires: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        check: z.array(z.string()).min(1),
        auth: z.array(z.string()).optional(),
        login: z.array(z.string()).optional(),
        install: z.object({ linux: z.string().optional(), darwin: z.string().optional() }).optional(),
        docs: z.string().optional(),
        optional: z.boolean().optional(),
        settings: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});

export const parseManifest = (raw: unknown): Manifest => manifestSchema.parse(raw);
export const parseTheme = (raw: unknown): Theme => themeSchema.parse(raw);

type Value = SettingValue;
type Handler = (req: RouteRequest) => unknown;
interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

interface Plugin {
  manifest: Manifest;
  dir: string;
  bundled: boolean;
  state: PluginState;
  error?: string;
  log: string[];
  routes: Route[];
  screens: ScreenInfo[];
  themes: Theme[];
  listeners: Map<PluginEvent, ((d: unknown) => void)[]>;
  stops: (() => void)[];
  generation: number;
  tracker?: Tracker;
  codeHost?: CodeHost;
  access?: AccessProvider;
}

const plugins = new Map<string, Plugin>();
const broken: { dir: string; error: string }[] = [];

// on/off and setting values, kept in the settings table so they survive updating the plugin's files
interface Saved {
  on?: boolean;
  settings?: Record<string, Value>;
}
const savedAll = () => readRow<Record<string, Saved>>("plugins") ?? {};
const saved = (id: string) => savedAll()[id] ?? {};
const save = (id: string, s: Saved) => writeRow("plugins", { ...savedAll(), [id]: s });

// bundled ones start on, yours start off until you turn them on
const isOn = (p: Plugin) => saved(p.manifest.id).on ?? (p.bundled && p.manifest.defaultOn !== false);

const MASK = "••••";
export function settingValue(p: Plugin, key: string): Value | undefined {
  const spec = p.manifest.settings?.find((s) => s.key === key);
  return saved(p.manifest.id).settings?.[key] ?? spec?.default;
}
const envOf = (p: Plugin) => {
  const env: Record<string, string> = {};
  for (const s of p.manifest.settings ?? []) {
    const v = settingValue(p, s.key);
    if (s.env && v !== undefined && v !== "") env[s.env] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return env;
};

function say(p: Plugin, ...args: unknown[]) {
  const line = `${new Date().toLocaleTimeString("en-GB")} ${args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a))).join(" ")}`;
  p.log.push(line);
  if (p.log.length > 200) p.log.splice(0, p.log.length - 200);
}

function scan() {
  broken.length = 0;
  const found = new Map<string, { dir: string; bundled: boolean; manifest: Manifest }>();
  for (const [base, bundled] of [
    [bundledDir, true],
    [userDir, false],
  ] as const) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const dir = join(base, name);
      const file = join(dir, "plugin.json");
      if (!existsSync(file)) continue;
      try {
        const manifest = parseManifest(JSON.parse(readFileSync(file, "utf8")));
        if (manifest.id !== name) throw new Error(`id "${manifest.id}" must match its folder name "${name}"`);
        // yours replaces a bundled one with the same id
        found.set(manifest.id, { dir, bundled, manifest });
      } catch (e) {
        broken.push({ dir, error: e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message });
      }
    }
  }
  return found;
}

const codeFile = (dir: string) => ["server.ts", "server.js", "server.mjs"].map((f) => join(dir, f)).find(existsSync);

// newest change anywhere in the folder, so editing any file reloads it
function stamp(dir: string): number {
  let newest = 0;
  const walk = (d: string, depth: number) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) depth < 4 && walk(p, depth + 1);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(dir, 0);
  return Math.round(newest);
}

function unload(p: Plugin) {
  for (const fn of p.stops) {
    try {
      fn();
    } catch (e) {
      say(p, "onStop failed:", e);
    }
  }
  p.generation++;
  p.routes = [];
  p.screens = [];
  p.themes = [];
  p.listeners = new Map();
  p.stops = [];
  p.tracker = undefined;
  p.codeHost = undefined;
  p.access = undefined;
}

function inside(dir: string, rel: string) {
  const full = resolve(dir, rel);
  if (full !== dir && !full.startsWith(dir + sep)) throw new Error(`${rel} is outside the plugin folder`);
  return full;
}

function makeApi(p: Plugin): Cockpit {
  const id = p.manifest.id;
  const gen = p.generation;
  // calls from a stale setup (after a reload) are ignored
  const live = () => p.generation === gen;
  const dataDir = join(userDir, ".data", id);
  return {
    id,
    dataDir,
    assetsDir: join(p.dir, "assets"),
    setting: <T>(key: string) => settingValue(p, key) as T,
    log: (...a) => say(p, ...a),
    store: {
      get: <T>(key: string) => readRow<Record<string, unknown>>(`plugin:${id}`)?.[key] as T | undefined,
      set: (key, value) => writeRow(`plugin:${id}`, { ...readRow<Record<string, unknown>>(`plugin:${id}`), [key]: value }),
    },
    route(method, path, handler) {
      if (!live()) return;
      p.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
    },
    screen(s) {
      if (!live()) return;
      inside(p.dir, s.page);
      p.screens.push({ plugin: id, id: s.id, title: s.title, url: `/plugins/${id}/${s.page.replace(/^\.?\//, "")}` });
    },
    theme(t) {
      if (!live()) return;
      const th = parseTheme(t);
      p.themes.push({ ...th, id: `${id}-${th.id}` });
    },
    on(event, fn) {
      if (!live()) return;
      p.listeners.set(event, [...(p.listeners.get(event) ?? []), fn]);
    },
    run: (cmd, args, opts) => run(cmd, args, { ...opts, env: envOf(p) }),
    terminal: (t) => spawnTerm(t),
    sessions: (o) => listSessions(o ?? {}),
    terminals: () => listTerms(),
    claude: (c) => spawnTerm({ cwd: c.cwd, command: "claude", args: c.prompt ? [c.prompt] : [], title: c.title ?? "claude" }),
    notify: (n) => notify({ title: n.title, body: n.body ?? "", link: n.link ?? "/" }),
    onStop: (fn) => void (live() && p.stops.push(fn)),
    cache: (key, maxAge, fn, force) => cached(`plugin:${id}:${key}`, maxAge, fn, force),
    ticketOf: (...hay) => ticketOf(...hay),
    tracker(t) {
      if (live()) p.tracker = t;
    },
    codeHost(h) {
      if (live()) p.codeHost = h;
    },
    access(a) {
      if (live()) p.access = a;
    },
    providers: { tracker: () => activeTracker()?.tracker, codeHost: () => activeCodeHost()?.codeHost },
  };
}

async function load(p: Plugin) {
  unload(p);
  p.error = undefined;
  if (!isOn(p)) {
    p.state = "off";
    return;
  }
  p.state = "loading";
  const errors: string[] = [];

  const themesDir = join(p.dir, "themes");
  if (existsSync(themesDir)) {
    for (const f of readdirSync(themesDir).filter((f) => f.endsWith(".json"))) {
      try {
        const t = parseTheme(JSON.parse(readFileSync(join(themesDir, f), "utf8")));
        p.themes.push({ ...t, id: `${p.manifest.id}-${t.id}` });
      } catch (e) {
        errors.push(`themes/${f}: ${e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message}`);
      }
    }
  }

  const file = codeFile(p.dir);
  if (file) {
    try {
      mkdirSync(join(userDir, ".data", p.manifest.id), { recursive: true });
      // a fresh URL each time, so an edited file is imported again instead of coming from the cache
      const mod = await import(`${pathToFileURL(file).href}?v=${stamp(p.dir)}`);
      if (typeof mod.default !== "function") throw new Error(`${file.split(sep).pop()} must export default function setup(k)`);
      await mod.default(makeApi(p));
    } catch (e) {
      unload(p);
      say(p, "setup failed:", e);
      errors.push((e as Error).stack ?? String(e));
    }
  }

  p.state = errors.length ? "error" : "on";
  p.error = errors.join("\n\n") || undefined;
  say(p, p.state === "on" ? "loaded" : "loaded with errors");
}

let reloading = Promise.resolve();
// one at a time, so a burst of file events doesn't import the same plugin twice in parallel
const serial = (fn: () => Promise<void>) => (reloading = reloading.then(fn, fn));

const afterChange = () => {
  setKeyPattern(activeTracker()?.tracker.keyPattern);
  broadcast({ type: "plugins" });
};

export function loadAll() {
  return serial(async () => {
    const found = scan();
    for (const [id, p] of plugins) {
      if (!found.has(id)) {
        unload(p);
        plugins.delete(id);
      }
    }
    for (const [id, f] of found) {
      const old = plugins.get(id);
      const p: Plugin = old ? Object.assign(old, f) : { ...f, state: "off", log: [], routes: [], screens: [], themes: [], listeners: new Map(), stops: [], generation: 0 };
      plugins.set(id, p);
      await load(p);
    }
    afterChange();
  });
}

export const reload = (id: string) =>
  serial(async () => {
    const p = plugins.get(id);
    if (!p) return;
    await load(p);
    afterChange();
  });

export function startPlugins() {
  mkdirSync(userDir, { recursive: true });
  onEvent((event, data) => {
    for (const p of plugins.values()) {
      for (const fn of p.listeners.get(event) ?? []) {
        try {
          fn(data);
        } catch (e) {
          say(p, `${event} handler failed:`, e);
        }
      }
    }
  });
  const timers = new Map<string, NodeJS.Timeout>();
  const changed = (file: string) => {
    const base = [bundledDir, userDir].find((b) => file.startsWith(b + sep));
    if (!base) return;
    const name = file.slice(base.length + 1).split(sep)[0];
    if (!name || name.startsWith(".")) return;
    clearTimeout(timers.get(name));
    timers.set(
      name,
      setTimeout(() => {
        // a new, renamed or removed manifest changes the list itself
        if (file.endsWith("plugin.json") || !plugins.has(name)) loadAll();
        else reload(name);
      }, 300),
    );
  };
  watch([bundledDir, userDir], { ignoreInitial: true, depth: 4, ignored: (p) => /(^|[/\\])(node_modules|\.data|\.git)([/\\]|$)/.test(p) })
    .on("all", (_e, file) => changed(file))
    .on("error", () => {});
  return loadAll();
}

// --- what the API and the app read -------------------------------------------------

function info(p: Plugin): PluginInfo {
  const settings: Record<string, Value> = {};
  for (const s of p.manifest.settings ?? []) {
    const v = settingValue(p, s.key);
    if (v === undefined) continue;
    settings[s.key] = s.type === "secret" ? (v ? MASK + String(v).slice(-4) : "") : v;
  }
  return {
    manifest: p.manifest,
    bundled: p.bundled,
    dir: p.dir,
    on: isOn(p),
    state: p.state,
    error: p.error,
    hasCode: !!codeFile(p.dir),
    settings,
    screens: p.screens,
    themes: p.themes.map((t) => t.name),
    provides: [...(p.tracker ? (["tracker"] as const) : []), ...(p.codeHost ? (["codeHost"] as const) : []), ...(p.access ? (["access"] as const) : [])],
  };
}

// What each plugin that's on needs installed, with the env its settings give its commands
export const pluginRequirements = () =>
  [...plugins.values()]
    .filter((p) => isOn(p))
    .map((p) => ({ plugin: p.manifest.id, name: p.manifest.name, dir: p.dir, requires: p.manifest.requires ?? [], skills: p.manifest.skills ?? [], env: envOf(p), settings: info(p).settings, specs: p.manifest.settings ?? [] }));

export const listPlugins = () => ({ plugins: [...plugins.values()].map(info), broken: [...broken], dirs: { bundled: bundledDir, user: userDir } });
export const pluginLog = (id: string) => plugins.get(id)?.log ?? [];

// The tracker and code host in use: the one picked in Settings if it's on, else the first plugin offering one.
function pick<K extends "tracker" | "codeHost">(kind: K) {
  const offering = [...plugins.values()].filter((p) => (p.state === "on" || p.state === "error") && p[kind]);
  const want = getSettings()[kind];
  const p = offering.find((x) => x.manifest.id === want) ?? offering[0];
  return p && { plugin: p.manifest.id, [kind]: p[kind]! } as { plugin: string } & Record<K, NonNullable<Plugin[K]>>;
}
export const accessProviders = () => [...plugins.values()].filter((p) => p.state === "on" && p.access).map((p) => p.access!);
export const activeTracker = () => pick("tracker");
export const activeCodeHost = () => pick("codeHost");
export const providerOptions = (kind: "tracker" | "codeHost") =>
  [...plugins.values()].filter((p) => (p.state === "on" || p.state === "error") && p[kind]).map((p) => ({ plugin: p.manifest.id, name: p[kind]!.name }));
const active = () => [...plugins.values()].filter((p) => p.state === "on" || p.state === "error");
export const pluginScreens = () => active().flatMap((p) => p.screens);
export const pluginThemes = () => active().flatMap((p) => p.themes);

// Turn a plugin on or off and change its settings. A secret sent back masked, or left out, keeps its value.
export async function updatePlugin(id: string, patch: { on?: boolean; settings?: Record<string, unknown> }) {
  const p = plugins.get(id);
  if (!p) throw Object.assign(new Error("no such plugin"), { status: 404 });
  const cur = saved(id);
  const next: Saved = { on: patch.on ?? cur.on, settings: { ...cur.settings } };
  for (const [key, raw] of Object.entries(patch.settings ?? {})) {
    const spec = p.manifest.settings?.find((s) => s.key === key);
    if (!spec) throw Object.assign(new Error(`unknown setting ${key}`), { status: 400 });
    if (spec.type === "secret" && typeof raw === "string" && raw.startsWith(MASK)) continue;
    if (raw === null || raw === "") {
      delete next.settings![key];
      continue;
    }
    let v: Value;
    if (spec.type === "bool") v = raw === true || raw === "true";
    else if (spec.type === "number") v = Number(raw);
    // a list comes as an array or as lines of text
    else if (spec.type === "list") v = (Array.isArray(raw) ? raw.map(String) : String(raw).split("\n")).map((x) => x.trim()).filter(Boolean);
    else if (spec.type === "json") {
      try {
        v = typeof raw === "string" ? JSON.parse(raw) : (raw as Value);
      } catch {
        throw Object.assign(new Error(`${spec.label} isn't valid JSON`), { status: 400 });
      }
    } else v = String(raw);
    if (spec.type === "number" && Number.isNaN(v)) throw Object.assign(new Error(`${spec.label} must be a number`), { status: 400 });
    if (spec.type === "choice" && !spec.choices?.includes(v as string)) throw Object.assign(new Error(`${spec.label} must be one of ${spec.choices?.join(", ")}`), { status: 400 });
    next.settings![key] = v;
  }
  save(id, next);
  await reload(id);
  return info(p);
}

// /api/plugins/<id>/x/<path>, matched against what the plugin registered; ":name" parts become params
export async function callRoute(id: string, method: string, path: string, query: Record<string, string>, body: unknown) {
  const p = plugins.get(id);
  if (!p || (p.state !== "on" && p.state !== "error")) throw Object.assign(new Error("plugin is off"), { status: 404 });
  const parts = path.split("/").filter(Boolean);
  for (const r of p.routes) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (r.parts.every((rp, i) => (rp.startsWith(":") ? ((params[rp.slice(1)] = decodeURIComponent(parts[i])), true) : rp === parts[i]))) {
      try {
        return await r.handler({ query, body, params });
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (!status || status >= 500) say(p, `${method} ${path} failed:`, e);
        throw e;
      }
    }
  }
  throw Object.assign(new Error(`no route ${method} ${path}`), { status: 404 });
}

// A file from a plugin's folder, for its screens. Only from plugins that are on, and never outside the folder.
export function pluginFile(id: string, rel: string) {
  const p = plugins.get(id);
  if (!p || p.state === "off") return;
  const full = inside(p.dir, rel);
  if (!existsSync(full) || !statSync(full).isFile()) return;
  // the code and the manifest stay private
  if (/^(server\.(ts|js|mjs)|plugin\.json)$/.test(rel)) return;
  return full;
}
