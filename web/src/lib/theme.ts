import { useSyncExternalStore } from "react";
import { themes, themeVars, type Theme } from "@cockpit/shared";
// the global window.desktop type lives there
import "./notifications";

// "auto" follows the OS between two picked themes. The resolved colours are saved too, so index.html can paint
// them before React loads.
const KEY = "theme";
const AUTO_KEY = "theme-auto";
const VARS_KEY = "theme-vars";
// themes from plugins, remembered so a chosen plugin theme paints before /api/config answers
const EXTRA_KEY = "theme-plugins";

interface State {
  choice: string;
  autoLight: string;
  autoDark: string;
  active: Theme;
  previewing?: string;
}

const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? undefined;
  } catch {
    return undefined;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

const dark = matchMedia("(prefers-color-scheme: dark)");
const auto = (() => {
  try {
    return JSON.parse(read(AUTO_KEY) ?? "{}") as { light?: string; dark?: string };
  } catch {
    return {};
  }
})();

let extra: Theme[] = (() => {
  try {
    return JSON.parse(read(EXTRA_KEY) ?? "[]") as Theme[];
  } catch {
    return [];
  }
})();
let all = [...themes, ...extra];
const themeById = (id: string) => all.find((t) => t.id === id);

let state: State = {
  choice: read(KEY) ?? "auto",
  autoLight: auto.light ?? "cockpit-light",
  autoDark: auto.dark ?? "cockpit-dark",
  active: themes[0],
};
const listeners = new Set<() => void>();

const resolve = (s: State) => themeById(s.previewing ?? (s.choice === "auto" ? (dark.matches ? s.autoDark : s.autoLight) : s.choice)) ?? themeById(dark.matches ? "cockpit-dark" : "cockpit-light")!;

function apply() {
  const t = resolve(state);
  const vars = themeVars(t);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.colorScheme = t.scheme;
  root.dataset.theme = t.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.ui.ground);
  window.desktop?.setColors?.({ background: t.ui.ground, foreground: t.ui.muted });
  // a preview isn't saved, so a reload goes back to the real choice
  if (!state.previewing) write(VARS_KEY, JSON.stringify({ vars, scheme: t.scheme, id: t.id }));
  state = { ...state, active: t };
  listeners.forEach((l) => l());
}

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  apply();
}

apply();
dark.addEventListener("change", apply);
// another tab or an embedded terminal frame changed the theme
addEventListener("storage", (e) => {
  if (e.key === KEY) set({ choice: e.newValue ?? "auto", previewing: undefined });
  if (e.key === EXTRA_KEY) {
    try {
      extra = JSON.parse(e.newValue ?? "[]") as Theme[];
      all = [...themes, ...extra];
      apply();
    } catch {}
  }
});

export const themeStore = {
  get: () => state,
  all: () => all,
  // the themes enabled plugins add; a chosen one whose plugin went away falls back to the default
  setExtra(next: Theme[]) {
    if (JSON.stringify(next) === JSON.stringify(extra)) return;
    extra = next;
    all = [...themes, ...extra];
    write(EXTRA_KEY, JSON.stringify(extra));
    apply();
  },
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  choose(choice: string) {
    write(KEY, choice);
    set({ choice, previewing: undefined });
  },
  setAuto(scheme: "light" | "dark", id: string) {
    const next = scheme === "light" ? { autoLight: id } : { autoDark: id };
    write(AUTO_KEY, JSON.stringify({ light: next.autoLight ?? state.autoLight, dark: next.autoDark ?? state.autoDark }));
    set({ ...next, previewing: undefined });
  },
  // hovering a theme in the picker shows it without choosing it
  preview(id?: string) {
    if (state.previewing === id) return;
    set({ previewing: id });
  },
};

export function useTheme() {
  return useSyncExternalStore(themeStore.subscribe, themeStore.get);
}

// Built-in themes plus the ones plugins add
export const useThemes = () => useSyncExternalStore(themeStore.subscribe, themeStore.all);

// For things that keep their own colours (xterm, Monaco): the active theme, re-rendering on change.
export const useActiveTheme = () => useTheme().active;
