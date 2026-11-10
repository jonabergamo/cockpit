import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { FocusState } from "@cockpit/shared";
import { api } from "./api";

export const FOCUS_LENGTHS = [25, 50, 90];

export const useFocus = () => useQuery({ queryKey: ["focus"], queryFn: () => api.get<FocusState>("/focus"), refetchInterval: 60_000 });

// what went wrong last, shown by the header's focus button whichever place started it (the palette, say)
let error = "";
const listeners = new Set<() => void>();
const setError = (e: string) => ((error = e), listeners.forEach((l) => l()));
export const useFocusError = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => error,
  );

// minutes, or null for until you turn it off
export function useFocusActions() {
  const qc = useQueryClient();
  const run = async (fn: () => Promise<FocusState>) => {
    try {
      setError("");
      qc.setQueryData(["focus"], await fn());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return {
    start: (minutes: number | null) => run(() => api.post<FocusState>("/focus", { minutes })),
    end: () => run(() => api.post<FocusState>("/focus", { off: true })),
    clear: () => run(() => api.del<FocusState>("/focus/held")),
  };
}

// "23m left", ticking on its own
export function useLeft(until: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return "";
  const m = Math.max(0, Math.ceil((until - now) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
}
