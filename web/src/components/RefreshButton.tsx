import { useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { Button } from "./ui";

export interface RefreshTarget {
  key: unknown[];
  // asked with fresh=1 so the server skips its cache too
  url?: string;
}

// what's being fetched again right now, so the parts showing it can wave until it lands
const refreshing = new Map<string, number>();
const listeners = new Set<() => void>();
const name = (key: unknown[]) => JSON.stringify(key);
function mark(keys: unknown[][], by: number) {
  for (const k of keys.map(name)) refreshing.set(k, (refreshing.get(k) ?? 0) + by);
  for (const fn of listeners) fn();
}
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));

export function useRefreshing(...keys: unknown[][]) {
  return useSyncExternalStore(subscribe, () => keys.some((k) => (refreshing.get(name(k)) ?? 0) > 0));
}

// Data loads once and stays; this is the one way to fetch it again.
export function RefreshButton({ targets, label = "Refresh", onDone }: { targets: RefreshTarget[]; label?: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const go = async () => {
    setBusy(true);
    setErr(undefined);
    const keys = targets.map((t) => t.key);
    mark(keys, 1);
    try {
      await Promise.all(
        targets.map(async (t) => {
          if (!t.url) return qc.invalidateQueries({ queryKey: t.key });
          qc.setQueryData(t.key, await api.get(`${t.url}${t.url.includes("?") ? "&" : "?"}fresh=1`));
        }),
      );
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      mark(keys, -1);
      setBusy(false);
    }
  };

  return (
    <Button onClick={go} disabled={busy} className={busy ? "wave" : ""} title={err ?? "Fetch it again from Jira, GitHub and git"}>
      {busy ? "Refreshing" : err ? "Retry refresh" : label}
    </Button>
  );
}
