import { useQuery } from "@tanstack/react-query";
import type { CanvasInfo } from "@cockpit/shared";
import { api } from "./api";

// this tab, so the push of a change it made itself doesn't make it fetch what it already shows
export const tabId = Math.random().toString(36).slice(2);

export const useCanvases = () => useQuery({ queryKey: ["canvas"], queryFn: () => api.get<CanvasInfo[]>("/canvas") });

// tabs or canvas: what the Terminals page opens on when the link doesn't say
const VIEW = "cockpit.terminalsView";
export type TermView = "tabs" | "canvas";
export const savedView = (): TermView => {
  try {
    return localStorage.getItem(VIEW) === "canvas" ? "canvas" : "tabs";
  } catch {
    return "tabs";
  }
};
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
