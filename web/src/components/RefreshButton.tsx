import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { Button } from "./ui";

export interface RefreshTarget {
  key: unknown[];
  // asked with fresh=1 so the server skips its cache too
  url?: string;
}

// Data loads once and stays; this is the one way to fetch it again.
export function RefreshButton({ targets, label = "Refresh", onDone }: { targets: RefreshTarget[]; label?: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const go = async () => {
    setBusy(true);
    setErr(undefined);
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
      setBusy(false);
    }
  };

  return (
    <Button onClick={go} disabled={busy} title={err ?? "Fetch it again from Jira, GitHub and git"}>
      {busy ? "Refreshing" : err ? "Retry refresh" : label}
    </Button>
  );
}
