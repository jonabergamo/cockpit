// cockpit's own quick questions to the local model (Settings → Automation → Quick answers), straight to Ollama
// without a job, on the machine Settings → Machines picks for them. Every caller keeps its old rule for when the
// answer is undefined: no model set, Ollama down or too slow. Nothing may depend on a local model being there.
import { requestWork } from "./remote/work.ts";
import { where } from "./placement/where.ts";
import { getSettings } from "./settings.ts";

export interface QuickAsk {
  url: string;
  model: string;
  prompt: string;
  // the most tokens the answer may take
  max: number;
}

export const quickOn = () => !!getSettings().quick.model;

// on this machine; a node answers its hub's with this too
export async function quickHere(q: QuickAsk, timeoutMs = 60_000): Promise<string> {
  const res = await fetch(`${q.url.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: q.model, prompt: q.prompt, stream: false, options: { temperature: 0, num_predict: q.max } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama said ${res.status}`);
  const d = (await res.json()) as { response?: string };
  return (d.response ?? "").trim();
}

// The answer, or undefined. A model that isn't loaded yet can take half a minute, so callers in a hurry give a
// shorter timeout and fall back to their rule for that one.
export async function quick(prompt: string, o: { max?: number; timeoutMs?: number } = {}): Promise<string | undefined> {
  const s = getSettings().quick;
  if (!s.model) return;
  const q: QuickAsk = { url: s.url, model: s.model, prompt, max: o.max ?? 40 };
  const timeoutMs = o.timeoutMs ?? 60_000;
  try {
    const node = where("quick");
    const out = node ? await requestWork<string>(node, "quick.ask", { q, timeoutMs }, timeoutMs + 5000) : await quickHere(q, timeoutMs);
    return out || undefined;
  } catch {
    return;
  }
}

// one line of the model's answer, without the quotes and full stop small models like to add
export const oneLine = (s?: string) =>
  s
    ?.split("\n")
    .map((l) => l.trim())
    .find(Boolean)
    ?.replace(/^["'`*]+|["'`*.]+$/g, "")
    .trim() || undefined;

// A yes or no question about some text; undefined when there's no answer to go by
export async function decide(question: string, text: string, timeoutMs?: number): Promise<boolean | undefined> {
  const a = await quick(`${text}\n\n${question} Answer with one word, yes or no.`, { max: 3, timeoutMs });
  if (!a) return;
  if (/^\W*yes\b/i.test(a)) return true;
  if (/^\W*no\b/i.test(a)) return false;
  return;
}
