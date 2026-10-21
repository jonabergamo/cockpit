import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { RefreshButton } from "../components/RefreshButton";
import { ErrorNote, Loading, PageHeader, Tag } from "../components/ui";
import { api } from "../lib/api";
import { ago, until, usd } from "../lib/format";
import { useCost } from "../lib/cost";
import { useTokens } from "./Report";

interface Limit {
  pct?: number;
  resetsAt?: number;
}

interface UsageRes {
  plan: { seatTier?: string; rateLimitTier?: string; billingType?: string };
  limits: { latest?: { at: number; five: Limit; seven: Limit }; series: { at: number; five: number; seven: number }[] };
  totals: {
    today: { costUSD: number; tokens: number };
    week: { costUSD: number; tokens: number };
    month: { costUSD: number; tokens: number };
    range: { costUSD: number; input: number; output: number; cacheRead: number; cacheWrite: number; requests: number };
    cacheShare: number;
  };
  days: { date: string; costUSD: number; tokens: number; output: number }[];
  models: { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; requests: number }[];
  heat: number[][];
  top: { sessions: { id: string; title: string; folder?: string; costUSD: number }[]; folders: { name: string; costUSD: number }[]; tickets: { name: string; costUSD: number }[] };
  indexing: boolean;
  hasLimitsFile: boolean;
}

const tok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// Plan windows: the bar turns amber past half and red past 80%, with the number always written next to it.
function Gauge({ label, limit }: { label: string; limit?: Limit }) {
  const pct = limit?.pct;
  const tone = pct === undefined ? "bg-line" : pct >= 80 ? "bg-red" : pct >= 50 ? "bg-amber" : "bg-cobalt";
  return (
    <div className="bg-panel border border-line rounded-lg px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[28px] font-semibold tracking-tight leading-none">{pct === undefined ? "?" : `${Math.round(pct)}%`}</span>
        <span className="text-muted">{label}</span>
      </div>
      <div className="h-2 rounded-full bg-ground mt-2.5 overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
      <div className="text-[12px] text-muted mt-1.5">{limit?.resetsAt ? `resets in ${until(limit.resetsAt)}` : "no reading yet"}</div>
    </div>
  );
}

// Hidden costs leave the token count as the headline
function Stat({ label, cost, tokens }: { label: string; cost: number; tokens: number }) {
  const c = useCost();
  return (
    <div className="bg-panel border border-line rounded-lg px-4 py-3" title={c.hidden ? undefined : c.hint}>
      <div className="text-[22px] font-semibold tracking-tight leading-none">{c.hidden ? tok(tokens) : usd(cost) || "$0.00"}</div>
      <div className="text-[13px] text-muted mt-1.5">
        {label} · {c.hidden ? "tokens" : `${c.real ? "" : "API value, "}${tok(tokens)} tokens`}
      </div>
    </div>
  );
}

const shortDate = (d: string) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Heatmap({ heat }: { heat: number[][] }) {
  const max = Math.max(1, ...heat.flat());
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="overflow-x-auto">
      <div className="inline-grid gap-[3px]" style={{ gridTemplateColumns: `36px repeat(24, minmax(14px, 1fr))` }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-[10px] text-faint text-center">
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
        {order.map((d) => (
          <div key={d} className="contents">
            <span className="text-[11px] text-muted self-center">{days[d]}</span>
            {heat[d].map((v, h) => (
              <span
                key={h}
                title={`${days[d]} ${h}:00, ${tok(v)} output tokens`}
                className="h-[16px] rounded-[3px]"
                style={{ background: v ? `color-mix(in srgb, var(--cobalt) ${Math.round(15 + (v / max) * 85)}%, var(--ground))` : "var(--ground)" }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function TopList({ title, items }: { title: string; items: { key: string; label: React.ReactNode; costUSD: number }[] }) {
  const cost = useCost();
  const max = Math.max(0.01, ...items.map((i) => i.costUSD));
  return (
    <section className="bg-panel border border-line rounded-lg p-4">
      <h2 className="font-semibold mb-2">{title}</h2>
      <div className="space-y-1.5">
        {items.map((i) => (
          <div key={i.key} className="text-[13px]">
            <div className="flex gap-2">
              <span className="flex-1 truncate">{i.label}</span>
              {!cost.hidden && <span className="text-muted">{usd(i.costUSD)}</span>}
            </div>
            <div className="h-1 rounded-full bg-ground mt-0.5">
              <div className="h-full rounded-full bg-cobalt" style={{ width: `${(i.costUSD / max) * 100}%` }} />
            </div>
          </div>
        ))}
        {!items.length && <div className="text-[13px] text-muted">Nothing in this range.</div>}
      </div>
    </section>
  );
}

interface ToolReport {
  days: number;
  tools: { name: string; calls: number; tokens: number }[];
  commands: { name: string; calls: number; tokens: number }[];
}

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function Bars({ title, rows }: { title: string; rows: ToolReport["tools"] }) {
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  return (
    <div className="min-w-0">
      <h3 className="text-[13px] font-medium mb-1.5">{title}</h3>
      <div className="space-y-1">
        {rows.slice(0, 10).map((r) => (
          <div key={r.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-center text-[12.5px]" title={`${r.calls} calls, about ${compact(r.tokens)} tokens of results`}>
            <div className="min-w-0">
              <div className="truncate font-mono text-[12px]">{r.name}</div>
              <div className="h-1.5 rounded-full bg-ground mt-0.5">
                <div className="h-full rounded-full bg-cobalt" style={{ width: `${Math.max(2, (r.tokens / max) * 100)}%` }} />
              </div>
            </div>
            <div className="text-right tabular-nums text-muted">
              {compact(r.tokens)} <span className="text-faint">· {r.calls}×</span>
            </div>
          </div>
        ))}
        {!rows.length && <div className="text-[12px] text-faint">Nothing yet. This fills in as transcripts are indexed.</div>}
      </div>
    </div>
  );
}

// What tool results put back into the context, the part of a session that grows fastest
function WhereTokensGo() {
  const q = useQuery({ queryKey: ["usage-tools"], queryFn: () => api.get<ToolReport>("/usage/tools?days=30"), staleTime: 5 * 60_000 });
  if (!q.data) return null;
  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div>
        <h2 className="font-semibold">Where tokens go</h2>
        <p className="text-[13px] text-muted mt-0.5">What tool results added to the context over the last 30 days, at about 4 characters a token. Big readers and chatty commands are where trimming pays off.</p>
      </div>
      <div className="grid md:grid-cols-2 gap-5">
        <Bars title="Tools" rows={q.data.tools} />
        <Bars title="Shell commands" rows={q.data.commands} />
      </div>
    </section>
  );
}

export function UsagePage() {
  const q = useQuery({ queryKey: ["usage"], queryFn: () => api.get<UsageRes>("/usage?days=30") });
  const t = useTokens();
  const cost = useCost();
  const u = q.data;

  const tooltip = { background: t.raised, border: `1px solid ${t.line}`, borderRadius: 6, color: t.ink, fontSize: 13 };

  return (
    <div className="max-w-[1200px] space-y-5">
      <PageHeader
        title="Usage"
        sub={
          u ? (
            <span className="flex flex-wrap gap-2 items-center">
              {[u.plan.seatTier, u.plan.rateLimitTier].filter(Boolean).map((x) => (
                <Tag key={x}>{x!.replace(/_/g, " ")}</Tag>
              ))}
              <span>Last 30 days of Claude Code on this machine</span>
              {u.indexing && <Tag tone="amber">still reading older transcripts</Tag>}
            </span>
          ) : undefined
        }
      >
        <RefreshButton targets={[{ key: ["usage"] }]} />
      </PageHeader>
      {q.isLoading && <Loading what="Adding up tokens" />}
      <ErrorNote error={q.error} />

      {u && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Gauge label="of the 5 hour window" limit={u.limits.latest?.five} />
            <Gauge label="of the weekly limit" limit={u.limits.latest?.seven} />
            <Stat label="Today" cost={u.totals.today.costUSD} tokens={u.totals.today.tokens} />
            <Stat label="This week" cost={u.totals.week.costUSD} tokens={u.totals.week.tokens} />
            <Stat label="This month" cost={u.totals.month.costUSD} tokens={u.totals.month.tokens} />
          </div>
          <p className="text-[12px] text-muted -mt-2">
            {u.limits.latest ? `Plan limits last read ${ago(u.limits.latest.at)} from the status line. They only update while a session is open.` : "Plan limits show up once a session's status line has run with the cockpit hook."}
            {cost.hidden ? " " : cost.real ? " Dollars are Claude Code's own totals for these tokens. " : " API value is what these tokens would cost at API prices, from Claude Code's own totals. Your plan doesn't charge it. "}
            Token counts come from the transcripts, which leave out
            its background calls (titles, recaps), so they run a few percent low.
          </p>

          {!cost.hidden && (
          <section className="bg-panel border border-line rounded-lg p-4">
            <div className="flex items-baseline gap-3 mb-2">
              <h2 className="font-semibold flex-1">{cost.label} per day</h2>
              <span className="text-[13px] text-muted">{usd(u.totals.range.costUSD)} over the range</span>
            </div>
            <div className="h-[220px]" role="img" aria-label={`Claude Code ${cost.label} per day`}>
              <ResponsiveContainer>
                <BarChart data={u.days.map((d) => ({ ...d, label: shortDate(d.date) }))} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barCategoryGap={3}>
                  <CartesianGrid stroke={t.line} vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: t.muted, fontSize: 11 }} axisLine={{ stroke: t.line }} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fill: t.muted, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                  <Tooltip contentStyle={tooltip} cursor={{ fill: t.line, opacity: 0.4 }} formatter={(v, _n, p) => [`${usd(Number(v))} · ${tok(p.payload.tokens)} tokens`, cost.label]} />
                  <Bar dataKey="costUSD" fill={t.cobalt} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
          )}

          <div className="grid lg:grid-cols-2 gap-5 items-start">
            <section className="bg-panel border border-line rounded-lg p-4">
              <h2 className="font-semibold">Tokens by model</h2>
              <p className="text-[13px] text-muted mb-3">
                {Math.round(u.totals.cacheShare * 100)}% of input came from the prompt cache, the cheap part. {tok(u.totals.range.requests)} requests.
              </p>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-muted text-left">
                    <th className="font-normal pb-1">Model</th>
                    <th className="font-normal pb-1 text-right">Output</th>
                    <th className="font-normal pb-1 text-right">Input</th>
                    <th className="font-normal pb-1 text-right">Cache read</th>
                    <th className="font-normal pb-1 text-right">Requests</th>
                  </tr>
                </thead>
                <tbody>
                  {u.models.map((m) => {
                    const share = m.output / Math.max(1, u.totals.range.output);
                    return (
                      <tr key={m.model} className="border-t border-line">
                        <td className="py-1.5">
                          <div>{m.model.replace("claude-", "")}</div>
                          <div className="h-1 rounded-full bg-ground mt-1 w-28">
                            <div className="h-full rounded-full bg-cobalt" style={{ width: `${share * 100}%` }} />
                          </div>
                        </td>
                        <td className="text-right">{tok(m.output)}</td>
                        <td className="text-right">{tok(m.input + m.cacheWrite)}</td>
                        <td className="text-right">{tok(m.cacheRead)}</td>
                        <td className="text-right">{tok(m.requests)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <section className="bg-panel border border-line rounded-lg p-4">
              <h2 className="font-semibold">When I use it</h2>
              <p className="text-[13px] text-muted mb-3">Output tokens by weekday and hour. Darker means more.</p>
              <Heatmap heat={u.heat} />
            </section>
          </div>

          <div className="grid md:grid-cols-3 gap-5 items-start">
            <TopList
              title="Top sessions"
              items={u.top.sessions.map((s) => ({
                key: s.id,
                costUSD: s.costUSD,
                label: (
                  <Link to="/sessions/$id" params={{ id: s.id }} className="hover:text-cobalt" title={s.folder}>
                    {s.title}
                  </Link>
                ),
              }))}
            />
            <TopList
              title="Top tickets"
              items={u.top.tickets.map((x) => ({
                key: x.name,
                costUSD: x.costUSD,
                label: (
                  <Link to="/tickets" search={{ key: x.name }} className="hover:text-cobalt">
                    {x.name}
                  </Link>
                ),
              }))}
            />
            <TopList title="Top folders" items={u.top.folders.map((x) => ({ key: x.name, costUSD: x.costUSD, label: x.name }))} />
          </div>

          <WhereTokensGo />

          <section className="bg-panel border border-line rounded-lg p-4">
            <h2 className="font-semibold">5 hour window over the last week</h2>
            {u.limits.series.length < 2 ? (
              <p className="text-[13px] text-muted mt-1">This fills in as the status line reports. History starts from when cockpit began saving it.</p>
            ) : (
              <div className="h-[200px] mt-2" role="img" aria-label="5 hour limit used over time">
                <ResponsiveContainer>
                  <LineChart data={u.limits.series.map((s) => ({ ...s, label: new Date(s.at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) }))} margin={{ top: 8, right: 16, bottom: 0, left: -12 }}>
                    <CartesianGrid stroke={t.line} vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: t.muted, fontSize: 11 }} axisLine={{ stroke: t.line }} tickLine={false} interval="preserveStartEnd" />
                    <YAxis domain={[0, 100]} tick={{ fill: t.muted, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                    <Tooltip contentStyle={tooltip} formatter={(v) => [`${v}%`, "5 hour window"]} />
                    <Line type="stepAfter" dataKey="five" stroke={t.cobalt} strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
