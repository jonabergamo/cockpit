import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { auth } from "./auth.ts";
import { forward, serveApi } from "./remote/forward.ts";
import { startAutomations, startHostServices, startHubServices } from "./startup.ts";
import { addMachine, hubId, listMachines, pairCommandOf, removeMachine, retryMachine, startMachines } from "./remote/machines.ts";
import { startNodeServer } from "./remote/node.ts";
import { config, demo, paths } from "./config.ts";
import { mountDemo } from "./demo.ts";
import { activeCodeHost, activeTracker, callRoute, listPlugins, movedScreens, pluginFile, pluginLog, pluginScreens, pluginThemes, startPlugins, updatePlugin } from "./plugins.ts";
import { migrateLegacy, statusConfig } from "./providers.ts";
import { install, installSkill, login, setupStatus } from "./requirements.ts";
import { detectBilling, getSettings, putSettings } from "./settings.ts";
import { repoState } from "./worktrees.ts";
import { install as installPlugin, preview as installPreview, uninstall, updatePreview } from "./pluginInstall.ts";
import { tasks } from "./routes/tasks.ts";
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
  // where repo.path points and whether it's a git checkout, so the Board can ask for one
  repo: { path: config.repo.path, state: repoState() },
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
  // the PR review screen offers "Include the backend" only when the review command takes it
  reviewBackend: !!config.reviews.backendNote,
  // placeholders in repo.createCommand beyond the built-in ones, which kinds of work have to fill
  createVars: [...new Set([...config.repo.createCommand.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].filter((v) => !["repo", "worktreesDir", "key", "slug", "branch", "name"].includes(v)),
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
  .route("/report", report)
  .route("/runs", runs)
  .route("/", work);

app.route("/api", api);
// a hub asks this machine's API for what runs here, over the link
serveApi((req) => api.fetch(req));

// files for plugin screens; the page loads /plugin-sdk.js from the app itself
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".map": "application/json" };
app.get("/plugins/:id/*", (c) => {
  const id = c.req.param("id");
  const rel = decodeURIComponent(c.req.path.slice(`/plugins/${id}/`.length));
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
startPlugins().catch((e) => console.error("plugins failed to start", e));

// all: everything here. node: what the machine does by itself, for a hub to show. hub: the screens and what's
// about you, with its nodes doing the work (automations move to the nodes; until then a hub doesn't run them)
if (!demo) {
  startHostServices();
  if (config.role !== "hub") startAutomations();
  if (config.role !== "node") {
    startHubServices();
    startMachines();
  }
  if (config.role === "node") startNodeServer().catch((e) => console.error("node: couldn't start", e));
}

export type Api = typeof api;
