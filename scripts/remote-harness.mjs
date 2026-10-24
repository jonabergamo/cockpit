// A hub and a node on this machine, each with its own data folder, tmux socket and ports, paired the way a user
// would pair them: add the machine on the hub, run the pairing command on the node. Then it checks the link comes
// up, goes down when the node stops, and comes back when it starts again. Run it after a build:
// `node scripts/remote-harness.mjs`.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
// the repo is on the node only, so worktrees and the code view on the hub can only be the node's
const repo = join(dirs.node, "repo");
mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "README.md"), "harness\n");
git("add", ".");
git("-c", "user.name=harness", "-c", "user.email=harness@example.com", "commit", "-qm", "first");
// a stand-in for claude on the node, so claude -p put there answers without calling Claude
const fakeBin = join(dirs.node, "bin");
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, "claude"), '#!/bin/sh\necho "answered on the node"\n', { mode: 0o755 });
// a plugin on both machines that hands a file over and says what arrived
for (const role of ["hub", "node"]) {
  const dir = join(dirs[role], "plugins", "harness-echo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id: "harness-echo", name: "Harness echo", api: 1 }));
  writeFileSync(
    join(dir, "server.ts"),
    `import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export default function setup(k) {
  k.expose("digest", (args, files) => ({ where: args.who, bytes: readFileSync(files.f).length, sha: createHash("sha1").update(readFileSync(files.f)).digest("hex") }));
  k.route("POST", "/send", ({ body }) => k.remote(k.where("whisper")).call("digest", { who: "node" }, { files: { f: body.path } }));
  k.route("GET", "/where", () => ({ role: process.env.COCKPIT_ROLE }));
  k.screen({ id: "echo", title: "Echo", page: "echo.html" });
  k.badge("echo", { count: 2, title: "two" });
}
`,
  );
  writeFileSync(join(dir, "echo.html"), "<!doctype html><title>Echo</title>");
}
const configs = {};
for (const role of ["hub", "node"]) {
  configs[role] = join(dirs[role], "config.toml");
  const toml = readFileSync(config, "utf8")
    // never the real claude: the hub's would fail loudly, the node's is the stand-in
    .replace(/^dir = .*$/m, `dir = "${claudeDir(role)}"\nbin = "${role === "node" ? join(fakeBin, "claude") : "/bin/false"}"`)
    .replace(/^extraRoots = .*$/m, "extraRoots = []")
    .replace(/^path = .*$/m, `path = "${role === "node" ? repo : ""}"`)
    .replace(/^worktreesDir = .*$/m, `worktreesDir = "${join(dirs[role], "worktrees")}"`)
    .replace(/^createCommand = .*$/m, 'createCommand = "git -C {repo} worktree add -q -b {branch} {worktreesDir}/{key}/{name}"');
  writeFileSync(configs[role], toml);
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
  let hub = start("hub");
  let node = start("node");
  await until("the hub", async () => (await api("hub", "/health")).role === "hub");
  await until("the node", async () => (await api("node", "/health")).role === "node");

  const added = await api("hub", "/machines", { method: "POST", body: JSON.stringify({ name: "devbox", address: `127.0.0.1:${ports.link}` }) });
  const [, , , , hubId, , token] = added.pair.split(" ");
  // not paired yet: the node turns the hub away
  await until("a refusal before pairing", async () => (await state()) === "refused");
  execFileSync(process.execPath, [join(root, "bin/cockpit"), "node", "pair", "--hub", hubId, "--token", token], { env: { ...process.env, COCKPIT_DATA: dirs.node } });
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

  // the node's repo: a worktree made, edited, read back and removed, all from the hub
  await until("the node's repo in the hub's worktrees", async () => (await api("hub", "/worktrees")).some((w) => w.main && w.node === "devbox"));
  const finished = (id) => until(`job ${id} to finish`, async () => (await api("hub", `/jobs/${id}`)).code !== undefined, 30_000).then(() => api("hub", `/jobs/${id}`));
  const made = await finished((await api("hub", "/worktrees", { method: "POST", body: JSON.stringify({ key: "ABC-1", summary: "try the node" }) })).id);
  if (made.code !== 0) throw new Error(`making the worktree failed: ${made.output}`);
  const wt = (await api("hub", "/worktrees")).find((w) => w.ticket === "ABC-1");
  if (wt?.node !== "devbox") throw new Error(`the new worktree came back as ${JSON.stringify(wt)}`);
  if (!(await api("hub", "/code/roots")).worktrees.some((w) => w.path === wt.path && w.node === "devbox")) throw new Error("the code view can't see the new worktree");
  console.log("worktree made on the node from the hub, its job followed here");
  const at = (path, q = {}) => `/code/fs/${path}?${new URLSearchParams({ root: wt.path, ...q })}`;
  await api("hub", at("file"), { method: "PUT", body: JSON.stringify({ path: "notes.txt", content: "written from the hub\n" }) });
  if (!(await api("hub", at("changes"))).some((ch) => ch.path === "notes.txt")) throw new Error("the change didn't show in the worktree");
  if ((await api("hub", at("file", { path: "notes.txt" }))).content !== "written from the hub\n") throw new Error("the file didn't read back");
  if (!(await api("hub", at("tree"))).includes("README.md")) throw new Error("the file tree didn't come over");
  const outside = await fetch(`http://127.0.0.1:${ports.hub}/api${at("file", { path: "../../../etc/passwd" })}`);
  if (outside.ok) throw new Error("a path outside the worktree was read");
  console.log("code view on the node: wrote, listed, read back, and kept inside the worktree");
  const gone = await finished((await api("hub", "/worktrees/delete", { method: "POST", body: JSON.stringify({ path: wt.path }) })).id);
  if (gone.code !== 0) throw new Error(`removing the worktree failed: ${gone.output}`);
  await until("the worktree to leave the list", async () => !(await api("hub", "/worktrees")).some((w) => w.path === wt.path));
  console.log("worktree removed on the node from the hub");

  // the node keeps the automations: the hub's settings reach it, its screens are answered by it, and what it
  // has to say reaches the hub once, even when it happened while the hub was away
  await api("hub", "/settings", { method: "PUT", body: JSON.stringify({ alerts: { stuckMinutes: 37, escalateMinutes: 15 } }) });
  await until("the hub's settings on the node", async () => (await api("node", "/settings")).settings.alerts.stuckMinutes === 37);
  console.log("hub's settings passed on to the node");
  const recorded = await api("node", "/runs", { method: "POST", body: JSON.stringify({ name: "node e2e", finished: true, status: "pass", output: "all green" }) });
  if (!(await api("hub", "/runs")).some((r) => r.id === recorded.id && r.node === "devbox")) throw new Error("the node's run isn't in the hub's list");
  if ((await api("hub", `/runs/${recorded.id}`)).name !== "node e2e") throw new Error("the node's run didn't open from the hub");
  console.log("node's runs listed and opened from the hub");
  const t0 = Date.now() - 1;
  const titles = async () => (await api("hub", `/digest?since=${t0}`)).map((e) => e.title);
  const once = async (title) => (await titles()).filter((t) => t === title).length === 1;
  await api("hub", "/tasks/overnight", { method: "POST", body: JSON.stringify({ on: true }) });
  await until("the node's notification on the hub", () => once("Overnight queue started"));
  await stop(hub);
  await api("node", "/tasks/overnight", { method: "POST", body: JSON.stringify({ on: false }) });
  hub = start("hub");
  await until("the hub to come back", async () => (await api("hub", "/health")).ok);
  await until("what happened while the hub was away", () => once("Overnight queue ended"), 45_000);
  await stop(hub);
  hub = start("hub");
  await until("the hub to come back again", async () => (await state()) === "up", 45_000);
  await new Promise((r) => setTimeout(r, 3000));
  if (!(await once("Overnight queue started")) || !(await once("Overnight queue ended"))) throw new Error(`the node's notifications came over more than once: ${JSON.stringify(await titles())}`);
  console.log("node's notifications reached the hub once, including the one from while it was away");

  // where things run: claude -p and a plugin's work put on the node
  await until("the link after the restarts", async () => (await state()) === "up", 45_000);
  await api("hub", "/machines/placement", { method: "PUT", body: JSON.stringify({ cap: "headless", value: "devbox" }) });
  const asked = await finished((await api("hub", "/claude/question", { method: "POST", body: JSON.stringify({ question: "what's left?" }) })).id);
  if (!/answered on the node/.test(asked.output)) throw new Error(`claude -p didn't run on the node: ${asked.output}`);
  console.log("claude -p ran on the node, set from the hub");
  for (const role of ["hub", "node"]) await api(role, "/plugins/harness-echo", { method: "PUT", body: JSON.stringify({ on: true }) });
  await api("hub", "/machines/placement", { method: "PUT", body: JSON.stringify({ cap: "whisper", value: "devbox" }) });
  const sha = (b) => createHash("sha1").update(b).digest("hex");
  const audio = join(dirs.hub, "recording.bin");
  const first = Buffer.alloc(5 * 1024 * 1024, 7);
  writeFileSync(audio, first);
  const send = () => api("hub", "/plugins/harness-echo/x/send", { method: "POST", body: JSON.stringify({ path: audio }) });
  let got = await send();
  if (got.where !== "node" || got.sha !== sha(first)) throw new Error(`the file didn't arrive whole: ${JSON.stringify(got)}`);
  appendFileSync(audio, Buffer.from("and some more"));
  got = await send();
  if (got.sha !== sha(readFileSync(audio))) throw new Error("the file that grew didn't arrive whole");
  // rewritten in place: the node's copy no longer matches and starts over
  writeFileSync(audio, Buffer.alloc(first.length + 13, 9));
  got = await send();
  if (got.sha !== sha(readFileSync(audio))) throw new Error("the rewritten file didn't arrive whole");
  console.log("a plugin's work ran on the node, its file copied over, only the new part when it grew");

  // a plugin put on the node runs only there: its routes answer from the node, its screen and badge show here
  if ((await api("hub", "/plugins/harness-echo/x/where")).role !== "hub") throw new Error("the plugin should run on the hub until it's put on the node");
  await api("hub", "/machines/plugins", { method: "PUT", body: JSON.stringify({ id: "harness-echo", value: "devbox" }) });
  if ((await api("hub", "/plugins/harness-echo/x/where")).role !== "node") throw new Error("the plugin's route didn't answer from the node");
  if (!(await api("hub", "/plugins/harness-echo/log")).some((l) => /runs on devbox/.test(l))) throw new Error("the plugin's code still loaded on the hub");
  await until("the node's plugin screen on the hub", async () => (await api("hub", "/plugins")).plugins.find((p) => p.manifest.id === "harness-echo")?.screens.some((x) => x.id === "echo"));
  await until("the node's plugin badge on the hub", async () => (await api("hub", "/badges"))["plugin:harness-echo/echo"]?.count === 2);
  console.log("a plugin put on the node runs only there, with its screen and badge on the hub");
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
