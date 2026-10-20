import { useSyncExternalStore } from "react";

// Terminal preferences that every open terminal follows.
const KEY = "term-copy-on-select";
let copyOnSelect = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();

export const termPrefs = {
  copyOnSelect: () => copyOnSelect,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  setCopyOnSelect(on: boolean) {
    copyOnSelect = on;
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {}
    listeners.forEach((l) => l());
  },
};

export const useCopyOnSelect = () => useSyncExternalStore(termPrefs.subscribe, termPrefs.copyOnSelect);
