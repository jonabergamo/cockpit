import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { shortPath } from "./format";

export type LaunchMode = "claude" | "resume" | "shell";
export const MODES: LaunchMode[] = ["claude", "resume", "shell"];

const LAST = "cockpit.lastClaudeCwd";
const MODE = "cockpit.launchMode";

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

// The launcher is opened from the Terminals page and from Cmd+K, so its state lives outside both.
let state = { open: false, last: read(LAST), mode: (MODES.find((m) => m === read(MODE)) ?? "claude") as LaunchMode };
const listeners = new Set<() => void>();
const set = (patch: Partial<typeof state>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const launcher = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  // a mode given starts there instead of on the last one used, like the Terminals page's + always opening on Claude
  open: (mode?: LaunchMode) => set(mode ? { open: true, mode } : { open: true }),
  close: () => set({ open: false }),
  setMode(mode: LaunchMode) {
    write(MODE, mode);
    set({ mode });
  },
};

export const useLauncher = () => useSyncExternalStore(launcher.subscribe, launcher.get);

// "resume" opens claude's own picker of past sessions in that folder
export async function launch(qc: QueryClient, cwd: string, mode: LaunchMode, label = shortPath(cwd).split("/").pop()!) {
  const t =
    mode === "shell"
      ? await api.post<{ id: string }>("/code/terms", { cwd, title: label })
      : await api.post<{ id: string }>("/claude/launch", { cwd, picker: mode === "resume", title: `${mode} · ${label}` });
  write(LAST, cwd);
  set({ last: cwd });
  await qc.invalidateQueries({ queryKey: ["terms"] });
  return t.id;
}
