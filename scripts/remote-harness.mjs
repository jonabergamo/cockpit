// A hub and a node on this machine, each with its own data folder, tmux socket and ports, paired the way a user
// would pair them: add the machine on the hub, run the pairing command on the node. Then it checks the link comes
// up, goes down when the node stops, and comes back when it starts again. Run it after a build:
// `node scripts/remote-harness.mjs`.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const config = join(root, "config.example.toml");
const ports = { hub: 18780, node: 18790, link: 18791 };
const dirs = { hub: mkdtempSync(join(tmpdir(), "cockpit-hub-")), node: mkdtempSync(join(tmpdir(), "cockpit-node-")) };
const procs = [];

// each side reads its own Claude folder: the hub an empty one, the node one with a session in it, so what the hub
// shows of it can only have come over the link
const SID = "0b5e55ed-0000-4000-8000-00000000c0de";
const claudeDir = (role) => join(dirs[role], "claude");
const transcript = join(claudeDir("node"), "projects", "-tmp-harness", `${SID}.jsonl`);
mkdirSync(join(claudeDir("hub"), "projects"), { recursive: true });
mkdirSync(join(claudeDir("node"), "projects", "-tmp-harness"), { recursive: true });
const line = (o) => `${JSON.stringify({ ...o, sessionId: SID, cwd: tmpdir() })}\n`;
writeFileSync(
  transcript,
  line({ type: "user", uuid: "u1", timestamp: "2026-01-02T10:00:00.000Z", message: { role: "user", content: "find the flaky checkout test" } }) +
    line({ type: "assistant", uuid: "a1", timestamp: "2026-01-02T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "The flaky one is the checkout spec." }] } }) +
    line({ type: "ai-title", aiTitle: "Harness session on the node" }),
);
const configs = {};
for (const role of ["hub", "node"]) {
  configs[role] = join(dirs[role], "config.toml");
  writeFileSync(configs[role], readFileSync(config, "utf8").replace(/^dir = .*$/m, `dir = "${claudeDir(role)}"`));
}

function start(role) {
  const env = { ...process.env, COCKPIT_CONFIG: configs[role], COCKPIT_DATA: dirs[role], COCKPIT_ROLE: role, PORT: String(ports[role]), COCKPIT_TMUX_SOCKET: `cockpit-harness-${role}`, COCKPIT_NODE_PORT: String(ports.link), COCKPIT_NODE_LISTEN: "127.0.0.1" };
  const p = spawn(join(root, "server/node_modules/.bin/tsx"), [join(root, "server/src/index.ts")], { cwd: join(root, "server"), env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  p.log = () => log;
  procs.push(p);
  return p;
}

const api = async (role, path, init) => {
  const r = await fetch(`http://127.0.0.1:${ports[role]}/api${path}`, { ...init, headers: { "content-type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${body.error ?? r.status}`);
  return body;
};

async function until(what, ok, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await ok()) return;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const state = async () => (await api("hub", "/machines")).machines[0]?.state;
const stop = (p) => new Promise((done) => (p.exitCode !== null ? done() : (p.once("exit", done), p.kill("SIGTERM"))));

let failed = false;
try {
  start("hub");
  let node = start("node");
  await until("the hub", async () => (await api("hub", "/health")).role === "hub");
  await until("the node", async () => (await api("node", "/health")).role === "node");

  const added = await api("hub", "/machines", { method: "POST", body: JSON.stringify({ name: "devbox", address: `127.0.0.1:${ports.link}` }) });
  const [, , , , hub, , token] = added.pair.split(" ");
  // not paired yet: the node turns the hub away
  await until("a refusal before pairing", async () => (await state()) === "refused");
  execFileSync(process.execPath, [join(root, "bin/cockpit"), "node", "pair", "--hub", hub, "--token", token], { env: { ...process.env, COCKPIT_DATA: dirs.node } });
  await api("hub", "/machines/devbox/retry", { method: "POST" });
  await until("the link to come up", async () => (await state()) === "up");
  console.log("paired and connected");

  // a terminal on the node, opened and watched through the hub like a browser would
  const tick = "i=0; while true; do echo tick $i; i=$((i+1)); sleep 0.3; done";
  const term = await api("hub", "/code/terms", { method: "POST", body: JSON.stringify({ cwd: tmpdir(), node: "devbox", command: "bash", args: ["-c", tick], title: "ticker" }) });
  const seen = { text: "", resets: 0, exited: false };
  const ws = new WebSocket(`ws://127.0.0.1:${ports.hub}/ws`);
  ws.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.id !== term.id) return;
    // like the browser: a reset clears the screen, and the whole scrollback follows
    if (ev.type === "pty.reset") (seen.text = ""), seen.resets++;
    if (ev.type === "pty.data") seen.text += ev.data;
    if (ev.type === "pty.exit") seen.exited = true;
  };
  await new Promise((ok) => (ws.onopen = ok));
  ws.send(JSON.stringify({ type: "pty.attach", id: term.id }));
  const ticks = () => [...seen.text.matchAll(/tick (\d+)/g)].map((m) => Number(m[1]));
  await until("the node's terminal output", async () => ticks().length >= 3);
  const termState = async () => (await api("hub", "/code/terms")).find((t) => t.id === term.id)?.state;
  if ((await termState()) !== "running") throw new Error("the node's terminal isn't listed as running");
  console.log(`terminal on the node streams through the hub (tick ${Math.max(...ticks())})`);

  const before = Math.max(...ticks());
  await stop(node);
  await until("the link to go down", async () => ["down", "connecting"].includes(await state()));
  await until("the terminal to show disconnected", async () => (await termState()) === "disconnected");
  console.log("node stopped: link down, terminal disconnected but still listed");
  // it keeps ticking on the node's tmux while the hub can't see it
  await new Promise((r) => setTimeout(r, 2000));

  node = start("node");
  await until("the link to come back", async () => (await state()) === "up", 45_000);
  const m = (await api("hub", "/machines")).machines[0];
  console.log(`node back: link up again (${m.info?.hostname}, ${m.info?.platform})`);
  await until("the terminal to run again", async () => (await termState()) === "running");
  await until("output from while it was away", async () => Math.max(...ticks()) > before + 5, 20_000);
  const after = ticks();
  if (seen.exited) throw new Error("the terminal was reported as exited");
  // the node's tmux client is new, so the screen starts over rather than piling the redraw on the old output
  // (tmux redraws in pieces, so counting lines in the raw stream says nothing; the copy's dedupe has unit tests)
  if (seen.resets < 2) throw new Error("the screen wasn't started over after reconnecting");
  console.log(`terminal back and current (tick ${Math.max(...after)}, ${seen.resets} clean restarts)`);
  ws.close();

  // the node's Claude sessions, through the hub
  await until("the node's session in the hub's list", async () => (await api("hub", "/sessions")).some((x) => x.id === SID && x.node === "devbox"));
  const one = await api("hub", `/sessions/${SID}`);
  if (one.title !== "Harness session on the node" || one.node !== "devbox") throw new Error(`the session came back as ${JSON.stringify(one)}`);
  const tail = await api("hub", `/sessions/${SID}/entries`);
  if (!tail.entries.some((e) => e.kind === "assistant" && /checkout spec/.test(e.text))) throw new Error("the transcript didn't come over");
  // the node builds its search index half a minute after it starts
  await until("search to find it on the node", async () => (await api("hub", "/sessions/search?q=flaky")).some((h) => h.id === SID && h.node === "devbox"), 60_000);
  console.log("node's sessions: listed, opened and searched from the hub");

  // following it live: a line written on the node shows up on the hub
  const live = { entries: [] };
  const watcher = new WebSocket(`ws://127.0.0.1:${ports.hub}/ws`);
  watcher.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === "entries" && ev.sessionId === SID) live.entries.push(...ev.entries);
  };
  await new Promise((ok) => (watcher.onopen = ok));
  watcher.send(JSON.stringify({ type: "watch", sessionId: SID, offset: tail.offset }));
  await new Promise((r) => setTimeout(r, 500));
  appendFileSync(transcript, line({ type: "assistant", uuid: "a2", timestamp: "2026-01-02T10:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Fixed it, the wait was too short." }] } }));
  await until("the new line live on the hub", async () => live.entries.some((e) => /wait was too short/.test(e.text ?? "")));
  watcher.close();
  console.log("node's session followed live through the hub");
  console.log("remote harness ok");
} catch (e) {
  failed = true;
  console.error(`remote harness failed: ${e.message}`);
  for (const p of procs) console.error(`--- ${p.spawnargs.at(-1)} ---\n${p.log().slice(-2000)}`);
} finally {
  await Promise.all(procs.map(stop));
  for (const role of ["hub", "node"]) {
    try {
      execFileSync("tmux", ["-L", `cockpit-harness-${role}`, "kill-server"], { stdio: "ignore" });
    } catch {}
    rmSync(dirs[role], { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}
