#!/usr/bin/env node
// A chat with a local model through Ollama's API, for a terminal: type, it answers as it goes, and it remembers the
// conversation until the terminal closes. With --review it first reads the folder's changes (uncommitted ones, or
// the branch against --base when there are none) and reviews them, then the chat goes on from there.
//   node chat.mjs --model qwen2.5-coder:7b [--url http://127.0.0.1:11434] [--review] [--base main]
// Plain JavaScript with no packages, so it runs on any machine cockpit is on.
import { renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { capDiff, diffBetween, fenced, git, MAX_DIFF, snapshot, topOf } from "./diff.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const url = arg("url", "http://127.0.0.1:11434").replace(/\/$/, "");
const model = arg("model");
const review = process.argv.includes("--review");
const base = arg("base", "main");
// where cockpit hears that an answer is done, to pass it along a line on the canvas
const turns = arg("turns");
// room for a real diff; Ollama's default of 4096 tokens cuts most reviews short
const CTX = 16384;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

if (!model) {
  console.error(red("Say which model: --model qwen2.5-coder:7b (Settings → Automation → Quick answers sets cockpit's)"));
  process.exit(2);
}

// what to review: the uncommitted changes, new files included, or the branch's commits since it left base
async function changes() {
  const cwd = process.cwd();
  if (!(await topOf(cwd))) return { error: "This folder isn't a git repo, so there are no changes to review." };
  const now = await snapshot(cwd);
  const local = now && (await diffBetween(cwd, "HEAD", now));
  if (local?.files.length) return { what: "the uncommitted changes", ...local };
  for (const b of [`origin/${base}`, base]) {
    const mb = (await git(cwd, ["merge-base", "HEAD", b]))?.trim();
    if (!mb) continue;
    const d = await diffBetween(cwd, mb, "HEAD");
    if (d?.files.length) return { what: `this branch's changes since ${b}`, ...d };
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
  if (turns && answer.trim())
    try {
      writeFileSync(`${turns}.tmp`, JSON.stringify({ text: answer, at: Date.now() }));
      renameSync(`${turns}.tmp`, turns);
    } catch {
      // cockpit only misses this one
    }
}

console.log(`${bold(model)} ${dim(`on ${url} · /clear forgets, /exit or Ctrl+D ends`)}`);

if (review) {
  const c = await changes();
  if (c.error) console.log(dim(c.error));
  else {
    const { text, cut, size } = capDiff(c.diff);
    const named = c.skipped.length ? `\n\nAlso changed, not shown (lock, generated or binary files): ${c.skipped.join(", ")}` : "";
    console.log(dim(`Reviewing ${c.what}${cut ? `, the first ${MAX_DIFF / 1000}k characters of ${Math.round(size / 1000)}k` : ""}…\n`));
    await ask(
      `Review ${c.what} below. List real bugs first, each with the file and line and why it breaks, then risks worth a second look, then at most three small nits. Skip anything that's fine. If nothing is wrong, say so in one line.${cut ? " The diff is cut short, so only judge what's there." : ""}\n\n${fenced(text)}${named}`,
    );
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `\n${bold("›")} ` });
rl.prompt();

// A paste (a turn the canvas passes on, say) comes as many lines: between the bracketed paste markers, or in a
// burst too fast to be typed. Either way it's one message. What comes in while it answers waits its turn.
const START = "\x1b[200~";
const END = "\x1b[201~";
const queue = [];
let pending = [];
let pasting = false;
let flushing;
let busy = false;

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const text = queue.shift();
    if (text === "/exit" || text === "/quit") return rl.close();
    if (text === "/clear") {
      messages.splice(1);
      console.log(dim("Forgotten. A fresh conversation."));
      continue;
    }
    await ask(text);
  }
  busy = false;
  rl.prompt();
}

function flush() {
  clearTimeout(flushing);
  const text = pending.join("\n").trim();
  pending = [];
  if (text) queue.push(text);
  if (queue.length) void drain();
  else if (!busy) rl.prompt();
}

// readline swallows the markers, so they're watched for on the raw input, before readline turns it into lines
let inPaste = false;
let afterPaste = false;
process.stdin.prependListener("data", (chunk) => {
  const s = chunk.toString();
  if (s.includes(START)) pasting = true;
  inPaste = pasting || s.includes(END);
  if (s.includes(END)) {
    pasting = false;
    afterPaste = true;
  }
  // readline makes its lines from this chunk right after this, in the same tick
  setImmediate(() => (inPaste = false));
});

rl.on("line", (raw) => {
  pending.push(raw.split(START).join("").split(END).join(""));
  // lines inside a paste wait for the rest of it
  if (inPaste) return;
  clearTimeout(flushing);
  // the paste's last line comes with the Enter after it
  if (afterPaste) {
    afterPaste = false;
    return flush();
  }
  // lines in a burst too fast to type are a paste without markers
  flushing = setTimeout(flush, 40);
});
rl.on("close", () => process.exit(0));
