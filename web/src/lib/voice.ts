import { useSyncExternalStore } from "react";
import { api } from "./api";

// Saying something to a terminal: the mic records while you talk, then the hub's Whisper turns it into text, which
// is typed into the terminal without pressing Enter, for you to read and send. One at a time, for one card.
export type VoiceState = { card?: string; term?: string; state: "idle" | "listening" | "hearing" | "error"; error?: string };

let now: VoiceState = { state: "idle" };
const subs = new Set<() => void>();
const set = (v: VoiceState) => {
  now = v;
  for (const s of subs) s();
};
let rec: MediaRecorder | undefined;
let chunks: Blob[] = [];
let cancelled = false;

const toBase64 = (b: Blob) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => no(r.error);
    r.readAsDataURL(b);
  });

async function start(card: string, term: string) {
  if (now.state === "listening" || now.state === "hearing") return;
  cancelled = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      for (const t of stream.getTracks()) t.stop();
      if (cancelled) return set({ state: "idle" });
      set({ card, term, state: "hearing" });
      try {
        const blob = new Blob(chunks, { type: rec?.mimeType || "audio/webm" });
        const { text } = await api.post<{ text: string }>("/dictate", { data: await toBase64(blob), type: blob.type });
        if (!text.trim()) return set({ card, term, state: "error", error: "Didn't catch anything: try again a little closer to the mic" });
        // pasted the way a terminal pastes, so it lands as one piece, and not sent: you read it first
        await api.post(`/code/terms/${term}/input`, { data: `\x1b[200~${text.trim()}\x1b[201~` });
        set({ state: "idle" });
        (document.querySelector(`[data-card="${term}"] .xterm-helper-textarea`) as HTMLElement | null)?.focus();
      } catch (e) {
        set({ card, term, state: "error", error: e instanceof Error ? e.message : String(e) });
      }
    };
    rec.start();
    set({ card, term, state: "listening" });
  } catch (e) {
    set({ card, term, state: "error", error: e instanceof Error && e.name === "NotAllowedError" ? "cockpit isn't allowed to use the mic: allow it for this page" : e instanceof Error ? e.message : String(e) });
  }
}

export const voice = {
  get: () => now,
  subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  // starts listening to this card, or, already listening to it, stops and sends what was said
  toggle: (card: string, term: string) => (now.state === "listening" && now.card === card ? rec?.stop() : start(card, term)),
  stop: () => now.state === "listening" && rec?.stop(),
  cancel: () => {
    if (now.state === "listening") {
      cancelled = true;
      rec?.stop();
    } else if (now.state === "error") set({ state: "idle" });
  },
};
export const useVoice = () => useSyncExternalStore(voice.subscribe, voice.get);
