import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SessionContext } from "@cockpit/shared";
import { api } from "../../lib/api";
import { useCost } from "../../lib/cost";
import { usd } from "../../lib/format";
import { usePrs, useTickets } from "../../lib/queries";

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
// how long, the way the status line said it: 25h33m, or 4m12s under an hour
const span = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m${s % 60}s`;
};
// green, then amber from half, red from four fifths: how full or how used up
const tone = (pct: number) => (pct >= 80 ? "text-red" : pct >= 50 ? "text-amber" : "text-green");
const fill = (pct: number) => (pct >= 80 ? "bg-red" : pct >= 50 ? "bg-amber" : "bg-green");
const PR_TONE: Record<string, string> = { OPEN: "text-green", MERGED: "text-cobalt", CLOSED: "text-red", DRAFT: "text-faint" };

// Along the foot of a terminal card, all that Claude Code's status line said in the terminal: the model and its
// effort, the folder, the worktree (linked to its ticket), the branch with uncommitted work and how far from
// upstream, its pull request, how full the context is, the plan's five hours and week, what the session has cost,
// how long it's been going and the lines it changed.
export function StatusFooter({ session, busy, cost }: { session?: string; busy: boolean; cost?: number }) {
  const money = useCost();
  const q = useQuery({
    queryKey: ["context", session],
    queryFn: () => api.get<SessionContext | null>(`/sessions/${session}/context`),
    enabled: !!session,
    refetchInterval: busy ? 5000 : 30_000,
  });
  const tickets = useTickets().data;
  const prs = usePrs().data;
  const c = q.data;
  if (!session || !c) return null;
  const dollars = c.costUSD || cost;
  const ticketUrl = c.ticket && [...(tickets?.tickets ?? []), ...(tickets?.epics ?? [])].find((t) => t.key === c.ticket)?.url;
  const pr = c.branch ? [...(prs?.mine ?? []), ...(prs?.review ?? [])].find((p) => p.branch === c.branch) : undefined;
  const prState = pr ? (pr.isDraft ? "DRAFT" : pr.state) : undefined;
  const left = c.five?.resetsAt ? c.five.resetsAt * 1000 - Date.now() : 0;
  const parts: ReactNode[] = [];
  if (c.model)
    parts.push(
      <span key="model" className="truncate min-w-0" title={c.model}>
        <span className="text-cobalt">{c.model}</span>
        {c.effort && <span> ({c.effort})</span>}
      </span>,
    );
  if (c.dir)
    parts.push(
      <span key="dir" className="text-muted truncate min-w-0" title={c.dir}>
        {c.dir}
      </span>,
    );
  if (c.worktree)
    parts.push(
      ticketUrl ? (
        <a key="wt" href={ticketUrl} target="_blank" rel="noreferrer" className="nodrag text-amber hover:underline truncate min-w-0" title={`${c.worktree}: ${c.ticket}`}>
          {c.worktree}
        </a>
      ) : (
        <span key="wt" className="text-amber truncate min-w-0" title="The worktree it's in">
          {c.worktree}
        </span>
      ),
    );
  if (c.branch)
    parts.push(
      <span key="branch" className="shrink-0" title={`${c.branch}${c.dirty ? ", with changes not committed" : ""}`}>
        <span className="text-ink">{c.branch}</span>
        {c.dirty && <span className="text-amber"> ●</span>}
        {!!c.ahead && <span className="text-green"> ↑{c.ahead}</span>}
        {!!c.behind && <span className="text-red"> ↓{c.behind}</span>}
      </span>,
    );
  if (pr && prState)
    parts.push(
      <a key="pr" href={pr.url} target="_blank" rel="noreferrer" className={`nodrag shrink-0 hover:underline ${PR_TONE[prState] ?? "text-faint"}`} title={pr.title}>
        #{pr.number} <span className="text-faint">{prState.toLowerCase()}</span>
      </a>,
    );
  if (c.pct !== undefined)
    parts.push(
      <span key="ctx" className="flex items-center gap-1 shrink-0" data-context={c.pct} title={`${c.tokens ? `${k(c.tokens)} of its` : "Of its"} ${k(c.window)} context${c.pct >= 75 ? ". Near the end it compacts, and what it knew gets summarised" : ""}`}>
        <span>ctx</span>
        <span className="w-10 h-1.5 rounded-full bg-ground overflow-hidden">
          <span className={`block h-full ${fill(c.pct)}`} style={{ width: `${Math.max(4, c.pct)}%` }} />
        </span>
        <span className={tone(c.pct)}>{c.pct}%</span>
      </span>,
    );
  if (c.five)
    parts.push(
      <span key="5h" className="shrink-0" title="The plan's five hours: how much is used, and when it starts again">
        5h <span className={tone(c.five.pct)}>{c.five.pct}%</span>
        {left > 0 && <span> ({`${Math.floor(left / 3_600_000)}h${Math.floor((left % 3_600_000) / 60_000)}m`})</span>}
      </span>,
    );
  if (c.seven)
    parts.push(
      <span key="7d" className="shrink-0" title="The plan's week: how much is used">
        7d <span className={tone(c.seven.pct)}>{c.seven.pct}%</span>
      </span>,
    );
  if (dollars && !money.hidden)
    parts.push(
      <span key="cost" className="text-amber shrink-0" title={`${money.label}. ${money.hint}`}>
        {usd(dollars)}
      </span>,
    );
  if (c.durationMs)
    parts.push(
      <span key="time" className="shrink-0" title="How long the session has been going">
        ⏱ {span(c.durationMs)}
      </span>,
    );
  if (c.added || c.removed)
    parts.push(
      <span key="lines" className="shrink-0" title="Lines it has added and removed">
        <span className="text-green">+{c.added ?? 0}</span> <span className="text-red">−{c.removed ?? 0}</span>
      </span>,
    );
  if (!parts.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-h-6 px-2.5 py-1 border-t border-line bg-raised text-[11px] text-faint tabular-nums shrink-0 overflow-hidden" data-status-line>
      {parts.map((p, i) => [i > 0 && <span key={`s${i}`} className="text-line">│</span>, p])}
    </div>
  );
}
