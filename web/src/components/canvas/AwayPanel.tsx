import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SessionStatus } from "@cockpit/shared";
import { api } from "../../lib/api";

interface AwayItem {
  term: string;
  session: string;
  title: string;
  status: SessionStatus;
  edited: string[];
  commands: number;
  commits: string[];
  last?: string;
  summary?: string;
}

const dot: Record<SessionStatus, string> = { busy: "bg-cobalt animate-pulse", waiting: "bg-amber animate-pulse", idle: "bg-green", ended: "bg-line" };
const word: Record<SessionStatus, string> = { busy: "still working", waiting: "waiting on you", idle: "done for now", ended: "ended" };

const howLong = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
};
const base = (p: string) => p.split("/").pop() ?? p;

// What the agents on this workspace did while you were away. Opened by itself when you come back to it, it only
// shows when there's something to tell; from the Recap button it says so when there isn't.
export function AwayPanel({ ws, since, asked, onGo, onClose }: { ws: string; since: number; asked: boolean; onGo: (term: string) => void; onClose: () => void }) {
  const q = useQuery({ queryKey: ["away", ws, since], queryFn: () => api.get<AwayItem[]>(`/canvas/${ws}/away?since=${since}`), staleTime: 60_000 });
  const items = q.data ?? [];
  const [opened] = useState(() => Date.now());
  useEffect(() => {
    if (!asked && q.isSuccess && !items.length) onClose();
  }, [asked, q.isSuccess, items.length, onClose]);
  if (!asked && !items.length) return null;
  return (
    <div className="absolute top-3 left-3 z-10 w-[420px] max-w-[calc(100%-24px)] max-h-[70%] flex flex-col rounded-lg border border-line bg-raised shadow-xl text-[13px]" role="region" aria-label="While you were away">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line shrink-0">
        <span className="font-medium">{asked ? "The last" : "While you were away"}</span>
        <span className="text-faint">{howLong(opened - since)}</span>
        <button type="button" onClick={onClose} className="ml-auto h-6 px-2 rounded text-muted hover:text-ink hover:bg-ground">
          Got it
        </button>
      </div>
      <div className="overflow-y-auto py-1">
        {q.isLoading ? (
          <div className="px-3 py-2 text-muted">Reading what they did</div>
        ) : q.error ? (
          <div className="px-3 py-2 text-red">Couldn't read it: {q.error instanceof Error ? q.error.message : String(q.error)}</div>
        ) : !items.length ? (
          <div className="px-3 py-2 text-muted">Nothing happened on this workspace in that time.</div>
        ) : (
          items.map((i) => (
            <button key={i.session} type="button" onClick={() => onGo(i.term)} className="w-full text-left px-3 py-2 hover:bg-ground border-b border-line/60 last:border-0" title="Go to its terminal">
              <div className="flex items-center gap-2">
                <span className={`size-2 rounded-full shrink-0 ${dot[i.status]}`} />
                <span className="font-medium truncate">{i.title}</span>
                <span className={`ml-auto shrink-0 text-[12px] ${i.status === "waiting" ? "text-amber font-medium" : "text-faint"}`}>{word[i.status]}</span>
              </div>
              {(i.summary || i.last) && <div className="mt-0.5 text-muted line-clamp-2">{i.summary || i.last}</div>}
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-faint">
                {i.edited.length > 0 && <span title={i.edited.join("\n")}>edited {i.edited.length === 1 ? base(i.edited[0]) : `${i.edited.length} files`}</span>}
                {i.commands > 0 && <span>ran {i.commands === 1 ? "a command" : `${i.commands} commands`}</span>}
                {i.commits.map((c) => (
                  <span key={c} className="text-green truncate max-w-full" title={c}>
                    committed “{c}”
                  </span>
                ))}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
