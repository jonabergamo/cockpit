import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AskInfo } from "@cockpit/shared";
import { api } from "../../lib/api";

// Across the top of a terminal card whose agent is waiting on you: what it asks, and its menu as buttons big enough
// to press with the canvas zoomed out. Anything else gets typed into the terminal itself.
// With its card selected (w goes from one to the next), the menu's numbers answer it from the keys, and then it's on
// to the next one waiting.
export function WaitingStrip({ session, selected, onBringUp, onAnswered, onFail }: { session: string; selected?: boolean; onBringUp: () => void; onAnswered?: () => void; onFail: (e: unknown) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["ask", session], queryFn: () => api.get<AskInfo>(`/sessions/${session}/ask`), refetchInterval: 2500 });
  const ask = q.data;
  const keys = async (k: string[]) => {
    setBusy(true);
    try {
      await api.post(`/sessions/${session}/keys`, { keys: k });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["ask", session] }), 400);
    } catch (e) {
      onFail(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!selected || !ask?.options.length) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest("input, textarea, select, [contenteditable], .xterm")) return;
      const o = ask.options.find((x) => x.key === e.key);
      if (!o || busy) return;
      e.preventDefault();
      void keys([o.key]).then(() => onAnswered?.());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const question = ask?.question ?? (ask?.pending ? `Wants to use ${ask.pending.name}` : "It's waiting for you");
  return (
    <div className="nodrag nowheel flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 bg-amber-soft border-b border-amber/50 text-[13px] shrink-0" data-waiting>
      <span className="font-medium text-amber truncate min-w-0 max-w-full" title={question}>
        {question}
      </span>
      {ask?.options.map((o) => (
        <button
          key={o.key}
          type="button"
          disabled={busy}
          onClick={() => keys([o.key])}
          className={`h-7 px-2 rounded-md border text-[13px] max-w-[220px] truncate disabled:opacity-50 ${o.key === "1" ? "bg-cobalt text-on-accent border-transparent" : "bg-raised border-line hover:border-faint"}`}
          title={o.label}
        >
          <span className="font-mono opacity-70 mr-1">{o.key}</span>
          {o.label}
        </button>
      ))}
      {selected && !!ask?.options.length && (
        <span className="text-[11px] text-muted ml-auto" data-keys-hint>
          {ask.options.length > 1 ? `1–${ask.options.length}` : "1"} to answer · w the next
        </span>
      )}
      {ask?.options.length ? (
        <button type="button" disabled={busy} onClick={() => keys(["Escape"])} className="h-7 px-2 rounded-md text-muted hover:text-ink hover:bg-raised" title="Esc: cancel and say what to do instead">
          Esc
        </button>
      ) : (
        <button type="button" onClick={onBringUp} className="h-7 px-2 rounded-md bg-raised border border-line hover:border-faint" title="Bring it up and type the answer in the terminal">
          Answer
        </button>
      )}
    </div>
  );
}
