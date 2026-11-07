import { useQuery } from "@tanstack/react-query";
import type { SessionContext } from "@cockpit/shared";
import { api } from "../../lib/api";
import { useCost } from "../../lib/cost";
import { usd } from "../../lib/format";

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
const span = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

// Along the foot of a terminal card, what Claude Code's status line said in the terminal: the model and its effort,
// how full the context is (amber from 75% and red from 90%: near the end Claude compacts, and what it knew gets
// summarised), what the session has cost, how long it's been going and the lines it changed.
export function StatusFooter({ session, busy, cost }: { session?: string; busy: boolean; cost?: number }) {
  const money = useCost();
  const q = useQuery({
    queryKey: ["context", session],
    queryFn: () => api.get<SessionContext | null>(`/sessions/${session}/context`),
    enabled: !!session,
    refetchInterval: busy ? 5000 : 60_000,
  });
  const c = q.data;
  if (!session || !c) return null;
  const pct = c.pct;
  const dollars = c.costUSD || cost;
  const tone = (pct ?? 0) >= 90 ? "bg-red" : (pct ?? 0) >= 75 ? "bg-amber" : "bg-cobalt";
  const text = (pct ?? 0) >= 90 ? "text-red" : (pct ?? 0) >= 75 ? "text-amber" : "text-muted";
  const dot = <span className="text-line">·</span>;
  return (
    <div className="flex items-center gap-2 h-6 px-2.5 border-t border-line bg-raised text-[11px] text-faint tabular-nums shrink-0 overflow-hidden whitespace-nowrap" data-status-line>
      {c.model && (
        <span className="truncate min-w-0" title={c.model}>
          <span className="text-muted">{c.model}</span>
          {c.effort && <span> ({c.effort})</span>}
        </span>
      )}
      {pct !== undefined && (
        <>
          {c.model && dot}
          <span className="flex items-center gap-1 shrink-0" data-context={pct} title={`${c.tokens ? `${k(c.tokens)} of its` : "Of its"} ${k(c.window)} context${pct >= 75 ? ". Near the end it compacts, and what it knew gets summarised" : ""}`}>
            <span className="w-10 h-1.5 rounded-full bg-ground overflow-hidden">
              <span className={`block h-full ${tone}`} style={{ width: `${Math.max(4, pct)}%` }} />
            </span>
            <span className={text}>{pct}%</span>
          </span>
        </>
      )}
      {!!dollars && !money.hidden && (
        <>
          {dot}
          <span className="shrink-0" title={`${money.label}. ${money.hint}`}>
            {usd(dollars)}
          </span>
        </>
      )}
      {!!c.durationMs && (
        <>
          {dot}
          <span className="shrink-0" title="How long the session has been going">
            {span(c.durationMs)}
          </span>
        </>
      )}
      {(!!c.added || !!c.removed) && (
        <>
          {dot}
          <span className="shrink-0" title="Lines it has added and removed">
            <span className="text-green">+{c.added ?? 0}</span> <span className="text-red">−{c.removed ?? 0}</span>
          </span>
        </>
      )}
    </div>
  );
}
