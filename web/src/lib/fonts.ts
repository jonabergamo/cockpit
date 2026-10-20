import { useSyncExternalStore } from "react";

// The interface and code fonts from Settings. Empty means the ones cockpit ships. A font the device
// doesn't have falls through to the shipped one, so a choice made on one machine is safe on another.
export interface Fonts {
  ui: string;
  code: string;
  codeSize: number;
}

const UI_FALLBACK = '"Schibsted Grotesk Variable", system-ui, sans-serif';
const CODE_FALLBACK = '"JetBrains Mono Variable", ui-monospace, monospace';
const KEY = "fonts";
export const defaultFonts: Fonts = { ui: "", code: "", codeSize: 13 };

const quote = (name: string) => `"${name.replace(/["\\]/g, "")}"`;
export const uiStack = (f: Fonts) => (f.ui ? `${quote(f.ui)}, ${UI_FALLBACK}` : UI_FALLBACK);
export const codeStack = (f: Fonts) => (f.code ? `${quote(f.code)}, ${CODE_FALLBACK}` : CODE_FALLBACK);

// the last fonts seen, so a reload doesn't flash the default ones before settings arrive
let state: Fonts = (() => {
  try {
    return { ...defaultFonts, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return defaultFonts;
  }
})();
const listeners = new Set<() => void>();

function apply() {
  const root = document.documentElement.style;
  root.setProperty("--app-font-sans", uiStack(state));
  root.setProperty("--app-font-mono", codeStack(state));
}
apply();

export const fontStore = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  set(next: Partial<Fonts>) {
    const merged = { ...state, ...next };
    if (JSON.stringify(merged) === JSON.stringify(state)) return;
    state = merged;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {}
    apply();
    listeners.forEach((l) => l());
  },
};

export const useFonts = () => useSyncExternalStore(fontStore.subscribe, fontStore.get);

// Monaco takes the font as an option rather than from CSS
export function useEditorFont() {
  const f = useFonts();
  return { fontFamily: codeStack(f), fontSize: f.codeSize };
}

// Measures text in the font and in two generic fallbacks: a font that's missing renders as the fallback.
let canvas: CanvasRenderingContext2D | null = null;
const ctx = () => (canvas ??= document.createElement("canvas").getContext("2d"));
const width = (font: string, text: string) => {
  const c = ctx()!;
  c.font = `32px ${font}`;
  return c.measureText(text).width;
};
const SAMPLE = "mmmmmmmmmmlli1WQ@#";

export function installed(name: string) {
  if (!ctx()) return true;
  return ["monospace", "serif"].some((generic) => width(`${quote(name)}, ${generic}`, SAMPLE) !== width(generic, SAMPLE));
}

export function monospace(name: string) {
  if (!ctx()) return false;
  const f = `${quote(name)}, serif`;
  return width(f, "iiiiiiiiii") === width(f, "WWWWWWWWWW");
}

export interface SystemFont {
  family: string;
  mono: boolean;
}

// The Local Font Access API, in Chromium browsers and the desktop app. It asks for permission the first
// time, so call it from a click. Safari and Firefox don't have it; there the name is typed in instead.
export const canListFonts = () => "queryLocalFonts" in window;

export async function listSystemFonts(): Promise<SystemFont[]> {
  const w = window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> };
  if (!w.queryLocalFonts) return [];
  const families = [...new Set((await w.queryLocalFonts()).map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  return families.map((family) => ({ family, mono: monospace(family) }));
}
