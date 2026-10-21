import { useSyncExternalStore } from "react";

// On by default, and only when the app isn't the window you're looking at.
const KEY = "notify";

const read = () => {
  try {
    return localStorage.getItem(KEY) ?? "background";
  } catch {
    return "background";
  }
};

export type NotifyMode = "off" | "background" | "always";
let mode = read() as NotifyMode;
const listeners = new Set<() => void>();

export const notifyStore = {
  get: () => mode,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  async set(next: NotifyMode) {
    if (next !== "off" && !window.desktop?.notify && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
    mode = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {}
    listeners.forEach((l) => l());
  },
};

export const useNotifyMode = () => useSyncExternalStore(notifyStore.subscribe, notifyStore.get);

declare global {
  interface Window {
    desktop?: {
      platform?: string;
      setColors?: (c: { background: string; foreground: string }) => void;
      notify?: (n: { title: string; body: string; link: string }) => void;
      onNavigate?: (fn: (link: string) => void) => void;
      back?: () => void;
      forward?: () => void;
      onNavState?: (fn: (s: { back: boolean; forward: boolean }) => void) => void;
    };
  }
}

// The desktop app shows a native notification; a browser tab uses the Notification API.
export function show(n: { title: string; body: string; link: string }, go: (link: string) => void) {
  if (mode === "off" || (mode === "background" && document.hasFocus())) return;
  if (window.desktop?.notify) return window.desktop.notify(n);
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const note = new Notification(n.title, { body: n.body, tag: n.link });
  note.onclick = () => {
    window.focus();
    go(n.link);
    note.close();
  };
}
