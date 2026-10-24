import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { auth } from "./auth.ts";
import { forward, serveApi } from "./remote/forward.ts";
import { placementView, pluginOn, type Cap } from "./placement/where.ts";
import { startAutomations, startHostServices, startHubServices } from "./startup.ts";
import { addMachine, hubId, listMachines, pairCommandOf, removeMachine, retryMachine, startMachines } from "./remote/machines.ts";
import { startNodeServer } from "./remote/node.ts";
import { resendSettings } from "./remote/sync.ts";
import { refreshPlugins } from "./remote/plugins.ts";
import { config, demo, paths } from "./config.ts";
import { mountDemo } from "./demo.ts";
import { placeable, reload as reloadPlugin } from "./plugins.ts";
import { activeCodeHost, activeTracker, callRoute, listPlugins, movedScreens, pluginFile, pluginLog, pluginScreens, pluginThemes, startPlugins, updatePlugin } from "./plugins.ts";
import { migrateLegacy, statusConfig } from "./providers.ts";
import { install, installSkill, login, setupStatus } from "./requirements.ts";
import { detectBilling, getSettings, putSettings } from "./settings.ts";
import { repoState } from "./worktrees.ts";
import { repoNode, requestWork } from "./remote/work.ts";
import { install as installPlugin, preview as installPreview, uninstall, updatePreview } from "./pluginInstall.ts";
import { tasks } from "./routes/tasks.ts";
import { agents } from "./routes/agents.ts";
import { flows } from "./routes/flows.ts";
import { claude } from "./routes/claude.ts";
import { code } from "./routes/code.ts";
import { report } from "./routes/report.ts";
import { runs } from "./routes/runs.ts";
import { sessions } from "./routes/sessions.ts";
import { work } from "./routes/work.ts";
import { canUpgrade, wss } from "./ws.ts";

const app = new Hono();

app.use("*", auth);
if (demo) mountDemo(app);
app.onError((err, c) => c.json({ error: err.message }, 500));

// errors a plugin throws with a .status (400 for bad input) keep it; anything else is a 500
const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 });

export const appConfig = () => ({
  statusOrder: statusConfig().statusOrder,
  releasedStatuses: statusConfig().releasedStatuses,
  repoName: config.repo.name,
  // where repo.path points and whether it's a git checkout, so the Board can ask for one; on a hub the repo is
  // usually on a node, which counts
  repo: repoNode() ? { path: config.repo.path, state: "ok" as const, node: repoNode() } : { path: config.repo.path, state: repoState() },
  // which plugins provide these, so screens that need one can hide
  tracker: activeTracker() ? { plugin: activeTracker()!.plugin, name: activeTracker()!.tracker.name } : null,
  codeHost: activeCodeHost() ? { plugin: activeCodeHost()!.plugin, name: activeCodeHost()!.codeHost.name } : null,
  demo,
  hidden: getSettings().hidden,
  screens: pluginScreens(),
  // screens plugins took away, and where their links go now
  moved: movedScreens(),
  themes: pluginThemes(),
  // which of the repo's own commands are set, so the Board only offers what will work
  verify: !!config.repo.verifyCommand,
  preview: !!config.repo.devCommand,
  // so the open buttons can say which editor they open
  openCommand: config.repo.openCommand,
  baseBranch: config.repo.baseBranch,
  // the PR review screen offers "Include the backend" only when the review command takes it
  reviewBackend: !!config.reviews.backendNote,
  // placeholders in repo.createCommand beyond the built-in ones, which kinds of work have to fill
  createVars: [...new Set([...config.repo.createCommand.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].filter((v) => !["repo", "worktreesDir", "key", "slug", "branch", "base", "name"].includes(v)),
});

const plugins = new Hono()
  .get("/", (c) => c.json(listPlugins()))
  // from a git link: look first (nothing runs), then install what was looked at
  .post("/install/preview", async (c) => {
    try {
      return c.json(await installPreview(await c.req.json()));
    } catch (e) {
      return fail(e);
    }
  })
  .post("/install", async (c) => {
    try {
      return c.json(await installPlugin((await c.req.json<{ token: string }>()).token));
    } catch (e) {
      return fail(e);
    }
  })
  .post("/:id/update/preview", async (c) => {
    try {
      return c.json(await updatePreview(c.req.param("id")));
    } catch (e) {
      return fail(e);
    }
  })
  .delete("/:id", async (c) => {
    try {
      return c.json(await uninstall(c.req.param("id")));
    } catch (e) {
      return fail(e);
    }
  })
  .put("/:id", async (c) => {
    try {
      return c.json(await updatePlugin(c.req.param("id"), await c.req.json()));
    } catch (e) {
      return fail(e);
    }
  })
  .get("/:id/log", (c) => c.json(pluginLog(c.req.param("id"))))
  .all("/:id/x/*", async (c) => {
    const id = c.req.param("id");
    const rest = c.req.path.slice(c.req.path.indexOf(`/${id}/x`) + id.length + 3);
    const body = ["POST", "PUT", "DELETE"].includes(c.req.method) ? await c.req.json().catch(() => undefined) : undefined;
    try {
      const out = await callRoute(id, c.req.method, rest, c.req.query(), body, c.req.header());
      if (out instanceof Response) return out;
      return c.json(out ?? { ok: true });
    } catch (e) {
      return fail(e);
    }
  });

// the nodes this hub works with
const machines = new Hono()
  .get("/", (c) => c.json({ hub: hubId(), role: config.role, machines: listMachines() }))
  .post("/", async (c) => {
    try {
      const { name, address } = await c.req.json<{ name: string; address: string }>();
      return c.json(addMachine(String(name ?? ""), String(address ?? "")));
    } catch (e) {
      return fail(e);
    }
  })
  // where each kind of work runs
  .get("/placement", (c) => c.json(placementView()))
  .put("/placement", async (c) => {
    const { cap, value } = await c.req.json<{ cap: Cap; value: string }>();
    if (!placementView().some((p) => p.id === cap)) return c.json({ error: "not a kind of work" }, 400);
    if (value !== "auto" && value !== "here" && !listMachines().some((m) => m.id === value)) return c.json({ error: "auto, here or a machine's id" }, 400);
    putSettings({ machines: { ...getSettings().machines, placement: { ...getSettings().machines.placement, [cap]: value } } });
    return c.json(placementView());
  })
  // where each plugin runs: here, or on a node, which then runs it alone
  .get("/plugins", (c) => {
    const set = getSettings().machines.plugins;
    return c.json(listPlugins().plugins.filter((p) => p.on && (p.machine || placeable(p.manifest.id))).map((p) => ({ id: p.manifest.id, name: p.manifest.name, bundled: p.bundled, value: set[p.manifest.id] ?? "here", machine: p.machine })));
  })
  .put("/plugins", async (c) => {
    const { id, value } = await c.req.json<{ id: string; value: string }>();
    if (!listPlugins().plugins.some((p) => p.manifest.id === id)) return c.json({ error: "no such plugin" }, 404);
    if (value !== "here" && !listMachines().some((m) => m.id === value)) return c.json({ error: "here or a machine's id" }, 400);
    if (value !== "here") {
      // what this hub's own screens use stays here, and the node has to have the plugin to run it
      if (!placeable(id)) return c.json({ error: "This plugin gives this machine a tracker, code host, review queue or login, so it stays here. The node runs it too, for the automations." }, 400);
      const has = await requestWork<{ id: string }[]>(value, "plugins.info").then((l) => l.some((p) => p.id === id), () => undefined);
      if (has === undefined) return c.json({ error: `${value} isn't connected, so it can't say whether it has this plugin` }, 503);
      if (!has) return c.json({ error: `${value} doesn't have this plugin. Install it there first.` }, 400);
    }
    const plugins = { ...getSettings().machines.plugins };
    if (value === "here") delete plugins[id];
    else plugins[id] = value;
    putSettings({ machines: { ...getSettings().machines, plugins } });
    await reloadPlugin(id);
    resendSettings();
    if (value !== "here") await refreshPlugins(value);
    return c.json({ ok: true });
  })
  .get("/:id/pair", (c) => {
    try {
      return c.json({ command: pairCommandOf(c.req.param("id")) });
    } catch (e) {
      return fail(e);
    }
  })
  .post("/:id/retry", (c) => c.json((retryMachine(c.req.param("id")), { ok: true })))
  .delete("/:id", (c) => {
    try {
      removeMachine(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      return fail(e);
    }
  });

// on a hub, what a node does is asked of that node; see remote/forward.ts
const api = new Hono()
  .use("*", forward)
  .get("/health", (c) => c.json({ ok: true, role: config.role }))
  .get("/config", (c) => c.json(appConfig()))
  .get("/settings", async (c) => c.json({ settings: getSettings(), billing: await detectBilling() }))
  .put("/settings", async (c) => {
    try {
      return c.json({ settings: putSettings(await c.req.json()), billing: await detectBilling() });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  })
  .get("/setup", async (c) => c.json(await setupStatus()))
  .post("/setup/:source/:id/install", (c) => {
    try {
      return c.json(install(c.req.param("source"), c.req.param("id")));
    } catch (e) {
      return fail(e);
    }
  })
  .post("/setup/:source/skills/:name", async (c) => {
    try {
      return c.json(await installSkill(c.req.param("source"), c.req.param("name")));
    } catch (e) {
      return fail(e);
    }
  })
  .post("/setup/:source/:id/login", (c) => {
    try {
      return c.json(login(c.req.param("source"), c.req.param("id")));
    } catch (e) {
      return fail(e);
    }
  })
  .route("/plugins", plugins)
  .route("/machines", machines)
  .route("/sessions", sessions)
  .route("/claude", claude)
  .route("/code", code)
  .route("/tasks", tasks)
  .route("/agents", agents)
  .route("/flows", flows)
  .route("/report", report)
  .route("/runs", runs)
  .route("/", work);

app.route("/api", api);
// a hub asks this machine's API for what runs here, over the link
serveApi((req) => api.fetch(req));

// files for plugin screens; the page loads /plugin-sdk.js from the app itself
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".map": "application/json" };
app.get("/plugins/:id/*", async (c) => {
  const id = c.req.param("id");
  const rel = decodeURIComponent(c.req.path.slice(`/plugins/${id}/`.length));
  // a plugin running on a node shows its screens as that node has them, which may be newer than this copy
  const on = pluginOn(id);
  if (on) {
    const f = await requestWork<{ ext: string; data: string } | null>(on, "plugin.asset", { id, rel }).catch(() => null);
    if (f) return new Response(Buffer.from(f.data, "base64"), { headers: { "content-type": types[f.ext] ?? "application/octet-stream", "cache-control": "no-cache" } });
  }
  let file: string | undefined;
  try {
    file = pluginFile(id, rel);
  } catch {
    file = undefined;
  }
  if (!file) return c.text("not found", 404);
  return new Response(readFileSync(file), { headers: { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" } });
});

// a node has no screens of its own; its hub shows them
if (existsSync(paths.web) && config.role !== "node") {
  const root = relative(process.cwd(), paths.web);
  // Built files carry a hash in their name, so they can be cached forever. The page itself must never be,
  // and is read on every request so a rebuild shows up on reload without restarting the server.
  app.use("/*", async (c, next) => {
    await next();
    if (c.req.path.startsWith("/api")) return;
    if (c.req.path.startsWith("/assets/") && c.res.ok) c.header("cache-control", "public, max-age=31536000, immutable");
    else if (c.res.headers.get("content-type")?.includes("text/html")) c.header("cache-control", "no-cache");
  });
  app.use("/*", serveStatic({ root }));
  app.get("*", (c) => c.html(readFileSync(join(paths.web, "index.html"), "utf8")));
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`cockpit on http://${info.address}:${info.port}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws" || !canUpgrade(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

if (!demo) migrateLegacy();
// a hub knows its machines before its plugins load, since a plugin put on a node doesn't load here
if (!demo && config.role !== "node") startMachines();
startPlugins()
  .then(() => config.role === "hub" && resendSettings())
  .catch((e) => console.error("plugins failed to start", e));

// all: everything here. node: what the machine does by itself, for a hub to show. hub: the screens and what's
// about you, with its nodes doing the work (automations move to the nodes; until then a hub doesn't run them)
if (!demo) {
  startHostServices();
  if (config.role !== "hub") startAutomations();
  if (config.role !== "node") startHubServices();
  if (config.role === "node") startNodeServer().catch((e) => console.error("node: couldn't start", e));
}

export type Api = typeof api;
