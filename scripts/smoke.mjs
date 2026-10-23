// Starts cockpit in demo mode on a spare port, opens every page in a headless browser and fails if any page
// throws or logs an error. Run it after a build: `pnpm build && pnpm smoke`.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const port = Number(process.env.SMOKE_PORT ?? 8799);
const base = `http://127.0.0.1:${port}`;
const data = mkdtempSync(join(tmpdir(), "cockpit-smoke-"));
const pages = ["/", "/board", "/tasks", "/tasks/g-423", "/sessions", "/workflows", "/tickets", "/worktrees", "/code", "/terminals", "/memory", "/reviews", "/report", "/usage", "/weekly", "/settings", "/runs", "/runs?kind=unit&status=fail"];
const phone = ["/settings", "/terminals", "/"];

const server = spawn("pnpm", ["--filter", "server", "start"], {
  // the example config, so the run never depends on (or shows) your own
  env: { ...process.env, COCKPIT_DEMO: "1", COCKPIT_CONFIG: new URL("../config.example.toml", import.meta.url).pathname, PORT: String(port), COCKPIT_DATA: data },
  stdio: "ignore",
  detached: true,
});

async function up() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/config`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server didn't start");
}

const problems = [];
let browser;
try {
  await up();
  // the runs API answers, with nothing in it yet (writes are no-ops in the demo)
  const json = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  for (const [path, ok] of [
    ["/api/runs", (r) => r.status === 200 && Array.isArray(r.body)],
    ["/api/runs?kind=unit&status=fail&limit=5", (r) => r.status === 200 && Array.isArray(r.body)],
    ["/api/runs/missing", (r) => r.status === 404],
    ["/api/runs/missing/log", (r) => r.status === 404],
    ["/api/runs/missing/artifacts/x.mp4", (r) => r.status === 404],
    ["/api/runs/hook", (r) => r.status === 200 && typeof r.body?.installed === "boolean"],
  ])
    if (!ok(await json(path))) problems.push(`${path}: unexpected answer`);
  browser = await chromium.launch();
  for (const [viewport, list] of [
    [{ width: 1440, height: 900 }, pages],
    [{ width: 390, height: 844 }, phone],
  ]) {
    const page = await (await browser.newContext({ viewport })).newPage();
    let at = "";
    page.on("pageerror", (e) => problems.push(`${at} (${viewport.width}px): ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/WebSocket|Failed to load resource/.test(m.text()) && problems.push(`${at} (${viewport.width}px): ${m.text()}`));
    for (const path of list) {
      at = path;
      await page.goto(base + path, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(400);
      // the page must fit the screen sideways
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (over > 1) problems.push(`${path} (${viewport.width}px): ${over}px wider than the screen`);
    }
  }
} catch (e) {
  problems.push(String(e));
} finally {
  await browser?.close();
  process.kill(-server.pid);
  rmSync(data, { recursive: true, force: true });
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`smoke ok: ${pages.length} pages, ${phone.length} on a phone`);
