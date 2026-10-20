import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api";
import { useCost } from "../lib/cost";
import { until, usd } from "../lib/format";

interface Limit {
  pct?: number;
  resetsAt?: number;
}

interface Summary {
  limits: { latest?: { five: Limit; seven: Limit } };
  totals: { today: { costUSD: number } };
}

// The plan windows and today's API value or cost at the bottom of the sidebar, same colours as the Usage page gauges.
function Bar({ label, limit }: { label: string; limit?: Limit }) {
  const pct = limit?.pct;
  const tone = pct === undefined ? "bg-line" : pct >= 80 ? "bg-red" : pct >= 50 ? "bg-amber" : "bg-cobalt";
  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-faint">{label}</span>
        <span className="tabular-nums text-ink">{pct === undefined ? "?" : `${Math.round(pct)}%`}</span>
        <span className="ml-auto tabular-nums text-faint">{limit?.resetsAt ? `resets in ${until(limit.resetsAt)}` : ""}</span>
      </div>
      <div className="h-1.5 mt-1 rounded-full bg-ground overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
    </div>
  );
}

export function UsageMini() {
  const q = useQuery({ queryKey: ["usage", "summary"], queryFn: () => api.get<Summary>("/usage?days=1"), refetchInterval: 60_000 });
  const l = q.data?.limits.latest;
  const cost = useCost();
  return (
    <Link to="/usage" className="block px-4 py-2.5 border-t border-line text-[12px] text-muted space-y-2 hover:bg-ground">
      <Bar label="5h" limit={l?.five} />
      <Bar label="7d" limit={l?.seven} />
      {!cost.hidden && (
        <div className="flex justify-between pt-0.5" title={cost.hint}>
          <span className="text-faint">{cost.real ? "Cost today" : "API value today"}</span>
          <span className="tabular-nums text-ink">{q.data ? usd(q.data.totals.today.costUSD) || "$0.00" : ""}</span>
        </div>
      )}
    </Link>
  );
}
