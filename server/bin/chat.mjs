#!/usr/bin/env node
// A chat with a local model through Ollama's API, for a terminal: type, it answers as it goes, and it remembers the
// conversation until the terminal closes. With --review it first reads the folder's changes (uncommitted ones, or
// the branch against --base when there are none) and reviews them, then the chat goes on from there.
//   node chat.mjs --model qwen2.5-coder:7b [--url http://127.0.0.1:11434] [--review] [--base main]
// Plain JavaScript with no packages, so it runs on any machine cockpit is on.
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const url = arg("url", "http://127.0.0.1:11434").replace(/\/$/, "");
const model = arg("model");
const review = process.argv.includes("--review");
const base = arg("base", "main");
// room for a real diff; Ollama's default of 4096 tokens cuts most reviews short
const CTX = 16384;
const MAX_DIFF = 40_000;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

if (!model) {
  console.error(red("Say which model: --model qwen2.5-coder:7b (Settings → Automation → Quick answers sets cockpit's)"));
  process.exit(2);
}

const git = (...a) => {
  try {
    return execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
};

// what to review: the uncommitted changes, new files included, or the branch's commits since it left base
function changes() {
  if (git("rev-parse", "--is-inside-work-tree")?.trim() !== "true") return { error: "This folder isn't a git repo, so there are no changes to review." };
  const untracked = (git("ls-files", "--others", "--exclude-standard") ?? "").split("\n").filter(Boolean);
  const local = (git("diff", "HEAD") ?? "") + untracked.map((f) => git("diff", "--no-index", "/dev/null", f) ?? "").join("");
  if (local.trim()) return { what: "the uncommitted changes", diff: local };
  for (const b of [`origin/${base}`, base]) {
    const mb = git("merge-base", "HEAD", b)?.trim();
    if (!mb) continue;
    const d = git("diff", `${mb}...HEAD`) ?? "";
    if (d.trim()) return { what: `this branch's changes since ${b}`, diff: d };
  }
  return { error: `Nothing to review: no uncommitted changes, and nothing on this branch that isn't on ${base}.` };
}

const messages = [{ role: "system", content: "You are a concise senior engineer helping in a terminal. Answer briefly and concretely. Use plain text and short code blocks, no long preambles." }];

async function ask(content) {
  messages.push({ role: "user", content });
  let res;
  try {
    res = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: CTX } }) });
  } catch (e) {
    messages.pop();
    console.log(red(`Ollama isn't answering at ${url} (${e.cause?.code ?? e.message}). Is it running on this machine?`));
    return;
  }
  if (!res.ok) {
    messages.pop();
    console.log(red(`Ollama said ${res.status}: ${(await res.text()).slice(0, 300)}`));
    return;
  }
  let answer = "";
  let buf = "";
  const started = Date.now();
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const d = JSON.parse(line);
      if (d.error) process.stdout.write(red(d.error));
      const piece = d.message?.content ?? "";
      answer += piece;
      process.stdout.write(piece);
      if (d.done) process.stdout.write(`\n${dim(`${((Date.now() - started) / 1000).toFixed(1)} s${d.eval_count ? `, ${d.eval_count} tokens` : ""}`)}\n`);
    }
  }
  messages.push({ role: "assistant", content: answer });
}

console.log(`${bold(model)} ${dim(`on ${url} · /clear forgets, /exit or Ctrl+D ends`)}`);

if (review) {
  const c = changes();
  if (c.error) console.log(dim(c.error));
  else {
    const cut = c.diff.length > MAX_DIFF;
    console.log(dim(`Reviewing ${c.what}${cut ? `, the first ${MAX_DIFF / 1000}k characters of ${Math.round(c.diff.length / 1000)}k` : ""}…\n`));
    await ask(
      `Review ${c.what} below. List real bugs first, each with the file and line and why it breaks, then risks worth a second look, then at most three small nits. Skip anything that's fine. If nothing is wrong, say so in one line.${cut ? " The diff is cut short, so only judge what's there." : ""}\n\n\`\`\`diff\n${c.diff.slice(0, MAX_DIFF)}\n\`\`\``,
    );
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `\n${bold("›")} ` });
rl.prompt();
let busy = false;
rl.on("line", async (line) => {
  const text = line.trim();
  if (busy) return;
  if (!text) return rl.prompt();
  if (text === "/exit" || text === "/quit") return rl.close();
  if (text === "/clear") {
    messages.splice(1);
    console.log(dim("Forgotten. A fresh conversation."));
    return rl.prompt();
  }
  busy = true;
  await ask(text);
  busy = false;
  rl.prompt();
});
rl.on("close", () => process.exit(0));
