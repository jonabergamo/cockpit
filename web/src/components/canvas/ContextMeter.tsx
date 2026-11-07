import { useQuery } from "@tanstack/react-query";
import type { SessionContext } from "@cockpit/shared";
import { api } from "../../lib/api";
import { useCost } from "../../lib/cost";
import { usd } from "../../lib/format";

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// How full the agent's context is, and what the session has cost, in a terminal card's header. Amber from 75% and
// red from 90%: near the end Claude compacts, and what it knew gets summarised.
export function ContextMeter({ session, busy, cost }: { session?: string; busy: boolean; cost?: number }) {
  const money = useCost();
  const q = useQuery({
    queryKey: ["context", session],
    queryFn: () => api.get<SessionContext | null>(`/sessions/${session}/context`),
    enabled: !!session,
    refetchInterval: busy ? 5000 : 60_000,
  });
  const c = q.data;
  const showCost = !!cost && !money.hidden;
  if (!c && !showCost) return null;
  const pct = c ? Math.min(100, Math.round((c.tokens / c.window) * 100)) : 0;
  const tone = pct >= 90 ? "bg-red" : pct >= 75 ? "bg-amber" : "bg-cobalt";
  const text = pct >= 90 ? "text-red" : pct >= 75 ? "text-amber" : "text-faint";
  return (
    <span className="flex items-center gap-1.5 shrink-0 text-[11px] tabular-nums" data-context={c ? pct : undefined}>
      {c && (
        <span className="flex items-center gap-1" title={`${k(c.tokens)} of its ${k(c.window)} context${pct >= 75 ? ". Near the end it compacts, and what it knew gets summarised" : ""}`}>
          <span className="w-8 h-1.5 rounded-full bg-ground overflow-hidden">
            <span className={`block h-full ${tone}`} style={{ width: `${Math.max(4, pct)}%` }} />
          </span>
          <span className={text}>{pct}%</span>
        </span>
      )}
      {showCost && (
        <span className="text-faint" title={`${money.label}. ${money.hint}`}>
          {usd(cost)}
        </span>
      )}
    </span>
  );
}
