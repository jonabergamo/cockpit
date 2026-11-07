// What the canvas end to end scripts share: a cockpit of their own on a spare port, with its own data folder and
// its own tmux server (so your terminals are never touched), a browser, and a list of steps that pass or fail.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

export const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

export const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// demo: the demo's tickets, worktrees and PRs instead of a tracker of your own
export async function startCockpit({ port, name, demo = false }) {
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), `cockpit-e2e-${name}-`));
  const socket = `cockpit-e2e-${name}-${process.pid}`;
  const server = spawn("pnpm", ["--filter", "server", "start"], {
    env: { ...process.env, COCKPIT_ROLE: "all", COCKPIT_TMUX_SOCKET: socket, COCKPIT_CONFIG: new URL("../config.example.toml", import.meta.url).pathname, PORT: String(port), COCKPIT_DATA: data, ...(demo ? { COCKPIT_DEMO: "1" } : {}) },
    stdio: "ignore",
    detached: true,
  });
  const api = async (method, path, body) => {
    const res = await fetch(base + "/api" + path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };
  const stop = () => {
    try {
      process.kill(-server.pid);
    } catch {}
    spawnSync("tmux", ["-L", socket, "kill-server"]);
    rmSync(data, { recursive: true, force: true });
  };
  try {
    await until("the server", async () => (await fetch(`${base}/api/config`)).ok, 30_000);
  } catch (e) {
    stop();
    throw e;
  }
  return {
    base,
    api,
    stop,
    shell: (title) => api("POST", "/code/terms", { cwd: homedir(), title }),
    canvasOf: async (kind, ref) => (await api("GET", "/canvas")).find((c) => c.nodes.some((n) => n.kind === kind && n.ref === ref)),
  };
}

export async function openBrowser(errors) {
  // a made-up mic, for talking to a terminal
  const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM, args } : { args });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ["clipboard-read", "clipboard-write", "microphone"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  return { browser, page };
}

// Each step reports ok or FAIL and the run carries on. E2E_SHOTS=<folder> keeps a screenshot of each failed step,
// E2E_PROOFS=<folder> one of each step that passed, as proof of what it showed.
export function steps(getPage) {
  const results = [];
  const step = async (name, fn) => {
    try {
      await fn();
      results.push(`ok   ${name}`);
      if (process.env.E2E_PROOFS) await getPage()?.screenshot({ path: join(process.env.E2E_PROOFS, `${String(results.length).padStart(2, "0")} ${name.replace(/[^\w -]+/g, "")}.png`) }).catch(() => {});
    } catch (e) {
      results.push(`FAIL ${name}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      if (process.env.E2E_SHOTS) await getPage()?.screenshot({ path: join(process.env.E2E_SHOTS, `${results.length}.png`) }).catch(() => {});
    }
  };
  const finish = () => {
    console.log(results.join("\n"));
    if (results.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;
  };
  return { step, results, finish };
}
