import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { shortPath } from "./format";

// local: a chat with the quick answers' local model (Ollama), codex: Codex's own terminal UI
export type LaunchMode = "claude" | "resume" | "shell" | "local" | "codex";
export const MODES: LaunchMode[] = ["claude", "resume", "shell", "local", "codex"];
// the two that can start by reviewing the folder's changes instead of an empty chat
export const REVIEWS: LaunchMode[] = ["local", "codex"];

// what local and codex need to start: the local model, the branch work goes back to, and whether to review
export interface LaunchExtra {
  model?: string;
  url?: string;
  base?: string;
  review?: boolean;
}

const reviewPrompt = (base: string) =>
  `Review the uncommitted changes in this repo, or if there are none, this branch's changes against origin/${base}. List real bugs first, each with the file and line and why it breaks, then risks worth a second look, then at most three small nits. Don't change any files.`;

const LAST = "cockpit.lastClaudeCwd";
const MODE = "cockpit.launchMode";
const nodeFolders = (node: string) => `cockpit.nodeFolders.${node}`;

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
// node: the machine it opens on, "local" for this one; each time it opens it starts on auto, the first connected
// node, so picking this machine once for something rare doesn't stick
// onLaunched: who opened it takes the new terminal from there (the canvas places it), instead of going to its tab
// review: local and codex start by reviewing the folder's changes, remembered like the mode
const REVIEW = "cockpit.launchReview";
let state: { open: boolean; last?: string; mode: LaunchMode; node: string; review: boolean; onLaunched?: (id: string) => void } = { open: false, last: read(LAST), mode: (MODES.find((m) => m === read(MODE)) ?? "claude") as LaunchMode, node: "auto", review: read(REVIEW) === "1" };
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
  open: (mode?: LaunchMode, onLaunched?: (id: string) => void) => set(mode ? { open: true, mode, node: "auto", onLaunched } : { open: true, node: "auto", onLaunched }),
  close: () => set({ open: false, onLaunched: undefined }),
  setMode(mode: LaunchMode) {
    write(MODE, mode);
    set({ mode });
  },
  setNode: (node: string) => set({ node }),
  setReview(review: boolean) {
    write(REVIEW, review ? "1" : "0");
    set({ review });
  },
};

// the folders used on a node, newest first; its folders can't be listed from here yet, so they're remembered
export const recentOn = (node: string): string[] => {
  try {
    return JSON.parse(read(nodeFolders(node)) ?? "[]");
  } catch {
    return [];
  }
};
const rememberOn = (node: string, cwd: string) => write(nodeFolders(node), JSON.stringify([cwd, ...recentOn(node).filter((p) => p !== cwd)].slice(0, 12)));

export const useLauncher = () => useSyncExternalStore(launcher.subscribe, launcher.get);

// the terminal for local and codex: cockpit's chat with the local model (each machine finds its own copy of the
// script) or Codex, read-only when it's reviewing
function agentTerm(mode: "local" | "codex", x: LaunchExtra): { command: string; args: string[]; title: string } {
  const base = x.base || "main";
  if (mode === "local") {
    if (!x.model) throw new Error("No local model yet: set one in Settings → Automation → Quick answers");
    const name = x.model.split(/[:/]/)[0];
    return { command: "cockpit:chat", args: ["--model", x.model, ...(x.url ? ["--url", x.url] : []), ...(x.review ? ["--review", "--base", base] : [])], title: x.review ? `${name} review` : name };
  }
  return { command: "codex", args: x.review ? ["-s", "read-only", reviewPrompt(base)] : [], title: x.review ? "codex review" : "codex" };
}

// "resume" opens claude's own picker of past sessions in that folder
export async function launch(qc: QueryClient, cwd: string, mode: LaunchMode, label = shortPath(cwd).split("/").pop()!, node = "local", extra: LaunchExtra = {}) {
  const on = node === "local" ? undefined : node;
  const agent = mode === "local" || mode === "codex" ? agentTerm(mode, extra) : undefined;
  const t = agent
    ? await api.post<{ id: string }>("/code/terms", { cwd, title: `${agent.title} · ${label}`, command: agent.command, args: agent.args, node: on })
    : mode === "shell"
      ? await api.post<{ id: string }>("/code/terms", { cwd, title: label, node: on })
      : await api.post<{ id: string }>("/claude/launch", { cwd, picker: mode === "resume", title: `${mode} · ${label}`, node: on });
  if (on) rememberOn(on, cwd);
  else {
    write(LAST, cwd);
    set({ last: cwd });
  }
  await qc.invalidateQueries({ queryKey: ["terms"] });
  return t.id;
}
