import { useSyncExternalStore } from "react";
import { api } from "./api";

// Saying something to a terminal: while you talk, what you've said so far goes to the hub's Whisper every second
// and a half and is typed into the terminal as it comes, each new pass correcting the last (only the part that
// changed is rubbed out and typed again). When you stop, one last pass settles it; it's left for you to read and
// send, or sent straight away when Settings says so. One at a time, for one card.
export type VoiceState = { card?: string; term?: string; state: "idle" | "listening" | "hearing" | "error"; error?: string; heard?: string };

let now: VoiceState = { state: "idle" };
const subs = new Set<() => void>();
const set = (v: VoiceState) => {
  now = v;
  for (const s of subs) s();
};

// what to rub out and what to type to go from what's in the terminal to what was heard: the two share a start,
// the rest of the old goes and the rest of the new comes (counted in characters, not UTF-16 units)
export function typedDiff(prev: string, next: string) {
  const a = Array.from(prev);
  const b = Array.from(next);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { erase: a.length - i, add: b.slice(i).join("") };
}

const toBase64 = (b: Blob) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => no(r.error);
    r.readAsDataURL(b);
  });

const PASS_MS = 1500;
let rec: MediaRecorder | undefined;
let chunks: Blob[] = [];
// what's been typed in so far, and the pass under way
let typed = "";
let inflight: Promise<void> | undefined;
let sentChunks = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let cancelled = false;
let sendAtEnd = false;

const input = (term: string, data: string) => (data ? api.post(`/code/terms/${term}/input`, { data }) : Promise.resolve());

// what's been said so far, heard, and the terminal brought in line with it
async function pass(term: string) {
  if (!chunks.length) return;
  sentChunks = chunks.length;
  const blob = new Blob(chunks, { type: rec?.mimeType || "audio/webm" });
  const { text } = await api.post<{ text: string }>("/dictate", { data: await toBase64(blob), type: blob.type });
  if (cancelled) return;
  const next = text.trim();
  // a pass that heard nothing yet leaves what's there
  if (!next) return;
  const d = typedDiff(typed, next);
  await input(term, "\x7f".repeat(d.erase) + d.add);
  typed = next;
  if (now.state === "listening") set({ ...now, heard: next });
}

async function start(card: string, term: string, send: boolean) {
  if (now.state === "listening" || now.state === "hearing") return;
  cancelled = false;
  sendAtEnd = send;
  typed = "";
  sentChunks = 0;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    // one pass at a time, and only when there's something new
    timer = setInterval(() => {
      if (inflight || chunks.length === sentChunks) return;
      inflight = pass(term)
        .catch(() => {})
        .finally(() => (inflight = undefined));
    }, PASS_MS);
    rec.onstop = async () => {
      clearInterval(timer);
      for (const t of stream.getTracks()) t.stop();
      await inflight;
      if (cancelled) {
        // what it typed goes again
        await input(term, "\x7f".repeat(Array.from(typed).length)).catch(() => {});
        typed = "";
        return set({ state: "idle" });
      }
      set({ card, term, state: "hearing", heard: now.heard });
      try {
        await pass(term);
        if (!typed) return set({ card, term, state: "error", error: "Didn't catch anything: try again a little closer to the mic" });
        if (sendAtEnd) await input(term, "\r");
        set({ state: "idle" });
        (document.querySelector(`[data-card="${term}"] .xterm-helper-textarea`) as HTMLElement | null)?.focus();
      } catch (e) {
        set({ card, term, state: "error", error: e instanceof Error ? e.message : String(e) });
      }
    };
    rec.start(1000);
    set({ card, term, state: "listening" });
  } catch (e) {
    set({ card, term, state: "error", error: e instanceof Error && e.name === "NotAllowedError" ? "cockpit isn't allowed to use the mic: allow it for this page" : e instanceof Error ? e.message : String(e) });
  }
}

export const voice = {
  get: () => now,
  subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  // starts listening to this card, or, already listening to it, stops; send: press Enter once it's settled
  toggle: (card: string, term: string, send = false) => (now.state === "listening" && now.card === card ? voice.stop() : start(card, term, send)),
  stop: () => {
    if (now.state !== "listening" || !rec) return;
    // what's still being recorded comes out first, so the last pass has all of it
    rec.requestData();
    rec.stop();
  },
  // listening: stop and rub out what it typed; an error: put it away
  cancel: () => {
    if (now.state === "listening") {
      cancelled = true;
      rec?.stop();
    } else if (now.state === "error") set({ state: "idle" });
  },
};
export const useVoice = () => useSyncExternalStore(voice.subscribe, voice.get);
