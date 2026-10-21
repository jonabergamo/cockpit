import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { auth } from "./auth.ts";
import { startSessions } from "./claude/sessions.ts";
import { config, demo, paths } from "./config.ts";
import { mountDemo } from "./demo.ts";
import { activeCodeHost, activeTracker, callRoute, listPlugins, pluginFile, pluginLog, pluginScreens, pluginThemes, startPlugins, updatePlugin } from "./plugins.ts";
import { restoreTerms } from "./pty.ts";
import { migrateLegacy, statusConfig } from "./providers.ts";
import { startSnapshots } from "./report.ts";
import { install, installSkill, login, setupStatus } from "./requirements.ts";
import { detectBilling, getSettings, putSettings } from "./settings.ts";
import { startStuckWatch } from "./stuck.ts";
import { startAutopilot } from "./autopilot.ts";
import { startVerify } from "./verify.ts";
import { startTasks } from "./tasks.ts";
import { tasks } from "./routes/tasks.ts";
import { startUsage } from "./usage.ts";
import { startSearch } from "./claude/search.ts";
import { claude } from "./routes/claude.ts";
import { code } from "./routes/code.ts";
import { report } from "./routes/report.ts";
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
  // which plugins provide these, so screens that need one can hide
  tracker: activeTracker() ? { plugin: activeTracker()!.plugin, name: activeTracker()!.tracker.name } : null,
  codeHost: activeCodeHost() ? { plugin: activeCodeHost()!.plugin, name: activeCodeHost()!.codeHost.name } : null,
  demo,
  hidden: getSettings().hidden,
  screens: pluginScreens(),
  themes: pluginThemes(),
  // which of the repo's own commands are set, so the Board only offers what will work
  verify: !!config.repo.verifyCommand,
  preview: !!config.repo.devCommand,
});

const plugins = new Hono()
  .get("/", (c) => c.json(listPlugins()))
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
      const out = await callRoute(id, c.req.method, rest, c.req.query(), body);
      return c.json(out ?? { ok: true });
    } catch (e) {
      return fail(e);
    }
  });

const api = new Hono()
  .get("/health", (c) => c.json({ ok: true }))
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
  .route("/sessions", sessions)
  .route("/claude", claude)
  .route("/code", code)
  .route("/tasks", tasks)
  .route("/report", report)
  .route("/", work);

app.route("/api", api);

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

if (existsSync(paths.web)) {
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

if (!demo) {
  startSessions();
  startSnapshots();
  startUsage();
  startSearch();
  startStuckWatch();
  startVerify();
  startAutopilot();
  startTasks();
  const restored = restoreTerms();
  if (restored) console.log(`reattached ${restored} terminals`);
}

export type Api = typeof api;
