// Speech to text for a few words said to a terminal: the same local Whisper the Meetings plugin uses, on the machine
// Settings → Machines puts transcription on (the one with the GPU, by default). One Whisper process keeps its model
// loaded for ten minutes after the last use, so each thing said after the first comes back in a second or two.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "./config.ts";
import { where } from "./placement/where.ts";
import { requestApi } from "./remote/forward.ts";
import { spawnServer } from "./util.ts";

const python = () => (process.env.COCKPIT_WHISPER_PYTHON ?? "~/.local/share/cockpit-whisper/bin/python").replace(/^~/, homedir());
const script = join(paths.root, "plugins", "meetings", "transcribe.py");
const MODEL = process.env.COCKPIT_WHISPER_MODEL ?? "large-v3-turbo";

type Heard = { language?: string; segments?: { text: string }[]; error?: string };
let worker: ReturnType<typeof spawnServer> | undefined;
let seq = 0;
let idle: NodeJS.Timeout | undefined;
const waiting = new Map<number, (r: Heard) => void>();

function hear(file: string): Promise<Heard> {
  if (!existsSync(python())) return Promise.resolve({ error: "Speech to text isn't set up on this machine: open Meetings and press Set it up (it installs Whisper)" });
  if (!worker) {
    const w = spawnServer(python(), [script, "--serve", MODEL], {
      onLine: (line) => {
        try {
          const r = JSON.parse(line);
          waiting.get(r.id)?.(r);
          waiting.delete(r.id);
        } catch {}
      },
      onExit: () => {
        if (worker === w) worker = undefined;
        for (const done of waiting.values()) done({ error: "the transcriber stopped" });
        waiting.clear();
      },
    });
    worker = w;
  }
  clearTimeout(idle);
  idle = setTimeout(() => worker?.kill(), 10 * 60_000);
  const id = ++seq;
  return new Promise((ok) => {
    waiting.set(id, ok);
    setTimeout(() => waiting.has(id) && (waiting.delete(id), ok({ error: "the transcription took too long" })), 120_000);
    worker!.write(JSON.stringify({ id, file, from: 0, names: ["", "", ""] }));
  });
}

// what was said, from a short recording (base64, as the browser recorded it)
export async function dictateHere(data: string, type = "audio/webm") {
  const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
  const file = join(tmpdir(), `cockpit-dictate-${randomUUID()}.${ext}`);
  writeFileSync(file, Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64"), { mode: 0o600 });
  try {
    const r = await hear(file);
    if (r.error) throw new Error(r.error);
    return { text: (r.segments ?? []).map((s) => s.text.trim()).filter(Boolean).join(" "), language: r.language };
  } finally {
    rmSync(file, { force: true });
  }
}

export async function dictate(data: string, type?: string): Promise<{ text: string; language?: string }> {
  const on = where("whisper");
  if (!on) return dictateHere(data, type);
  const r = await requestApi(on, { method: "POST", path: "/dictate", headers: { "content-type": "application/json" }, body: JSON.stringify({ data, type, here: true }) }, 130_000);
  const b = JSON.parse(r.body || "{}");
  if (r.status !== 200) throw new Error(b.error ?? `transcribing on ${on} failed`);
  return b;
}
