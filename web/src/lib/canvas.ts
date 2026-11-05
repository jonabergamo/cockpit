import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { CanvasInfo } from "@cockpit/shared";
import { api } from "./api";

// this tab, so the push of a change it made itself doesn't make it fetch what it already shows
export const tabId = Math.random().toString(36).slice(2);

export const useCanvases = () => useQuery({ queryKey: ["canvas"], queryFn: () => api.get<CanvasInfo[]>("/canvas") });

// tabs or canvas: what the Terminals page opens on when the link doesn't say, set in Settings for each device. The
// canvas unless you chose tabs, or the screen is a phone's.
const VIEW = "cockpit.terminalsView";
export type TermView = "tabs" | "canvas";
export const savedView = (): TermView => {
  try {
    const v = localStorage.getItem(VIEW);
    if (v === "canvas" || v === "tabs") return v;
  } catch {}
  return typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches ? "tabs" : "canvas";
};

// The strip at the top asks the canvas to bring a terminal up (every click, not just the first), and the canvas says
// which terminal is selected on it, for the strip to mark
const focusers = new Set<(term: string) => void>();
export const focusOnCanvas = (term: string) => focusers.forEach((f) => f(term));
export const onFocusRequest = (f: (term: string) => void) => (focusers.add(f), () => void focusers.delete(f));
let selectedTerm: string | undefined;
const selectedListeners = new Set<() => void>();
export const setCanvasSelected = (term?: string) => {
  if (term === selectedTerm) return;
  selectedTerm = term;
  selectedListeners.forEach((l) => l());
};
export const useCanvasSelected = () =>
  useSyncExternalStore(
    (l) => (selectedListeners.add(l), () => void selectedListeners.delete(l)),
    () => selectedTerm,
  );
export const saveView = (v: TermView) => {
  try {
    localStorage.setItem(VIEW, v);
  } catch {}
};

const WS = "cockpit.canvasWorkspace";
export const savedWorkspace = () => {
  try {
    return localStorage.getItem(WS) ?? undefined;
  } catch {
    return undefined;
  }
};
export const saveWorkspace = (id: string) => {
  try {
    localStorage.setItem(WS, id);
  } catch {}
};
