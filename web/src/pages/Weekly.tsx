import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Ticket } from "@cockpit/shared";
import { api, qs } from "../lib/api";
import { useCost } from "../lib/cost";
import { today, usd } from "../lib/format";
import { Button, copy, ErrorNote, inputClass, Loading, PageHeader, Tag } from "../components/ui";
import { useAgentName } from "../lib/agent";

interface Weekly {
  from: string;
  to: string;
  shipped: { prs: { number: number; title: string; url: string; ticket?: string; at: string }[]; tickets: { key: string; summary: string; status: string; url?: string }[] };
  stuck: { title: string; ticket?: string; why: string; days: number; card: string }[];
  usage: { tokens: number; output: number; lastWeek: number; costUSD?: number; sessions: number; perDay: { date: string; tokens: number }[] };
  top: { sessions: { id: string; title: string; ticket?: string; tokens: number; costUSD?: number }[]; tickets: { ticket: string; tokens: number; costUSD?: number; sessions: number }[] };
}

const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const shift = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
};
const nice = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" });

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="bg-panel border border-line rounded-lg">
      <h2 className="px-4 py-2.5 border-b border-line font-semibold text-[14px]">
        {title} {count !== undefined && <span className="text-faint font-normal">{count}</span>}
      </h2>
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

// tokens per day, one series, so no legend; each bar says its own number on hover
function Days({ days }: { days: Weekly["usage"]["perDay"] }) {
  const max = Math.max(1, ...days.map((d) => d.tokens));
  return (
    <div className="flex items-end gap-2 h-28 px-4 pt-3 pb-1" role="img" aria-label="New tokens per day">
      {days.map((d) => (
        <div key={d.date} className="flex-1 flex flex-col items-center gap-1 h-full justify-end" title={`${nice(d.date)}: ${tok(d.tokens)} tokens`}>
          <div className="w-full max-w-[28px] rounded-t-[4px] bg-cobalt" style={{ height: `${Math.max(d.tokens ? 2 : 0, (d.tokens / max) * 100)}%` }} />
          <span className="text-[11px] text-faint">{new Date(`${d.date}T12:00:00`).toLocaleDateString([], { weekday: "short" })}</span>
        </div>
      ))}
    </div>
  );
}

export function WeeklyPage() {
  const { week } = useSearch({ from: "/weekly" });
  const navigate = useNavigate();
  const cost = useCost();
  const q = useQuery({ queryKey: ["weekly", week], queryFn: () => api.get<Weekly>(`/weekly${qs({ week })}`) });
  const d = q.data;
  // a week that holds today is this week, which goes without the parameter so the page knows it is the live one
  const holdsToday = (from: string) => shift(from, 6) >= today();
  const go = (days: number) => {
    if (!d) return;
    const from = shift(d.from, days);
    navigate({ to: "/weekly", search: { week: holdsToday(from) ? undefined : from } });
  };
  const change = d && d.usage.lastWeek ? Math.round(((d.usage.tokens - d.usage.lastWeek) / d.usage.lastWeek) * 100) : undefined;
  const thisWeek = !week || (!!d && holdsToday(d.from));

  return (
    <div className="max-w-[980px] space-y-4">
      <PageHeader title="Your week" sub={d ? `${nice(d.from)} to ${nice(d.to)}` : undefined}>
        <Button variant="ghost" onClick={() => go(-7)} disabled={!d}>
          Week before
        </Button>
        {!thisWeek && (
          <Button variant="ghost" onClick={() => go(7)} disabled={!d}>
            Week after
          </Button>
        )}
      </PageHeader>
      {q.isLoading && <Loading what="Adding up the week" />}
      <ErrorNote error={q.error} />
      {d && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              [d.shipped.prs.length, "PRs merged"],
              [d.shipped.tickets.length, "tickets done"],
              [thisWeek ? d.stuck.length : "–", "stuck now"],
              [tok(d.usage.tokens), change === undefined ? "new tokens" : `new tokens, ${change >= 0 ? "+" : ""}${change}% on the same days last week`],
            ].map(([n, label]) => (
              <div key={String(label)} className="bg-panel border border-line rounded-lg px-4 py-3">
                <div className="text-[24px] font-semibold tabular-nums">{n}</div>
                <div className="text-[13px] text-muted">{label}</div>
              </div>
            ))}
          </div>

          <Section title="New tokens by day">
            <Days days={d.usage.perDay} />
            <p className="px-4 py-2 text-[12px] text-faint">
              Input, output and cache writes across {d.usage.sessions} sessions{!cost.hidden && d.usage.costUSD !== undefined ? `, ${usd(d.usage.costUSD)} as ${cost.label.toLowerCase()}` : ""}.
            </p>
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Shipped" count={d.shipped.prs.length + d.shipped.tickets.length}>
              {d.shipped.prs.map((p) => (
                <a key={p.number} href={p.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-4 py-2 text-[13px] hover:bg-ground">
                  <Tag tone="green">#{p.number}</Tag>
                  <span className="truncate flex-1">{p.title}</span>
                </a>
              ))}
              {d.shipped.tickets.map((t) => (
                <div key={t.key} className="flex items-center gap-2 px-4 py-2 text-[13px]">
                  <span className="font-mono text-[12px]">{t.key}</span>
                  <span className="truncate flex-1 text-muted">{t.summary}</span>
                  <Tag>{t.status}</Tag>
                </div>
              ))}
              {!d.shipped.prs.length && !d.shipped.tickets.length && <p className="px-4 py-3 text-[13px] text-faint">Nothing merged or done this week.</p>}
            </Section>

            <Section title="Stuck" count={thisWeek ? d.stuck.length : undefined}>
              {!thisWeek && <p className="px-4 py-3 text-[13px] text-faint">Only this week shows what's stuck, from the Board as it is now.</p>}
              {thisWeek &&
                d.stuck.map((s) => (
                  <Link key={s.card} to="/board" search={{ card: s.card }} className="block px-4 py-2 text-[13px] hover:bg-ground">
                    <div className="flex items-center gap-2">
                      {s.ticket && <span className="font-mono text-[12px]">{s.ticket}</span>}
                      <span className="truncate flex-1">{s.title}</span>
                      {s.days > 0 && <span className="text-[12px] text-faint">{s.days}d</span>}
                    </div>
                    <div className="text-[12px] text-amber">{s.why}</div>
                  </Link>
                ))}
              {thisWeek && !d.stuck.length && <p className="px-4 py-3 text-[13px] text-faint">Nothing is waiting on you.</p>}
            </Section>

            <Section title="Most expensive sessions">
              {d.top.sessions.map((s) => (
                <Link key={s.id} to="/sessions/$id" params={{ id: s.id }} className="flex items-center gap-2 px-4 py-2 text-[13px] hover:bg-ground">
                  <span className="truncate flex-1">{s.title}</span>
                  {s.ticket && <span className="font-mono text-[12px] text-muted">{s.ticket}</span>}
                  <span className="tabular-nums w-16 text-right">{tok(s.tokens)}</span>
                  {!cost.hidden && s.costUSD !== undefined && <span className="tabular-nums w-16 text-right text-muted">{usd(s.costUSD)}</span>}
                </Link>
              ))}
              {!d.top.sessions.length && <p className="px-4 py-3 text-[13px] text-faint">No sessions this week.</p>}
            </Section>

            <Section title="Tickets by tokens">
              {d.top.tickets.map((t) => (
                <Link key={t.ticket} to="/tickets" search={{ key: t.ticket }} className="flex items-center gap-2 px-4 py-2 text-[13px] hover:bg-ground">
                  <span className="font-mono text-[12px] flex-1">{t.ticket}</span>
                  <span className="text-[12px] text-faint">
                    {t.sessions} {t.sessions === 1 ? "session" : "sessions"}
                  </span>
                  <span className="tabular-nums w-16 text-right">{tok(t.tokens)}</span>
                  {!cost.hidden && t.costUSD !== undefined && <span className="tabular-nums w-16 text-right text-muted">{usd(t.costUSD)}</span>}
                </Link>
              ))}
              {!d.top.tickets.length && <p className="px-4 py-3 text-[13px] text-faint">No session was tied to a ticket.</p>}
            </Section>
          </div>
        </>
      )}
      {/* today's standup and this week's brag doc lines, only while the page is on this week */}
      {thisWeek && (
        <div className="grid gap-4 lg:grid-cols-2 items-start">
          <DailyText />
          <BragBox />
        </div>
      )}
    </div>
  );
}

function DailyText() {
  const agent = useAgentName();
  const daily = useQuery({ queryKey: ["daily"], queryFn: () => api.get<string>("/report/daily") });
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (daily.data) setText(daily.data);
  }, [daily.data]);

  const refine = useMutation({
    mutationFn: async () => {
      const job = await api.post<{ id: string }>("/claude/ask", {
        prompt: `Rewrite this daily standup update so it reads naturally, short and first person, plain text with the same four headings. Don't invent anything:\n\n${text}`,
      });
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const j = await api.get<{ output: string; code?: number }>(`/jobs/${job.id}`);
        if (j.code !== undefined) {
          if (j.code !== 0) throw new Error(j.output.slice(-400));
          return j.output.trim();
        }
      }
      throw new Error(`${agent} took too long`);
    },
    onSuccess: setText,
  });

  return (
    <section className="bg-panel border border-line rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="font-semibold flex-1">My daily</h2>
        <Button size="sm" variant="ghost" onClick={() => daily.refetch()}>
          Rebuild
        </Button>
        <Button size="sm" onClick={() => refine.mutate()} disabled={refine.isPending || !text}>
          {refine.isPending ? `${agent} is rewriting` : `Polish with ${agent}`}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            copy(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {daily.isLoading ? <Loading what="Putting it together" /> : <textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} className={`${inputClass} h-auto w-full py-2 font-sans leading-relaxed`} />}
      <ErrorNote error={daily.error ?? refine.error} />
    </section>
  );
}

function BragBox() {
  const w = useQuery({
    // its own key: ["weekly"] is this page's own summary
    queryKey: ["brag-week"],
    queryFn: () => api.get<{ from: string; to: string; released: Ticket[]; prsMerged: { number: number; title: string }[]; commits: number; costUSD: number; sessions: number }>("/report/weekly"),
  });
  if (!w.data)
    return (
      <section className="bg-panel border border-line rounded-lg p-4">
        <h2 className="font-semibold mb-2">This week, for the brag doc</h2>
        {w.isLoading && <Loading />}
        <ErrorNote error={w.error} />
      </section>
    );
  const d = w.data;
  const text = [
    `Week of ${nice(d.from)} to ${nice(d.to)}`,
    ...d.released.map((t) => `- Released ${t.key} ${t.summary}`),
    ...d.prsMerged.map((p) => `- Merged #${p.number} ${p.title}`),
    `- ${d.commits} commits, ${d.sessions} sessions`,
  ].join("\n");
  return (
    <section className="bg-panel border border-line rounded-lg p-4">
      <div className="flex items-center mb-2">
        <h2 className="font-semibold flex-1">This week, for the brag doc</h2>
        <Button size="sm" onClick={() => copy(text)}>
          Copy
        </Button>
      </div>
      <pre className="whitespace-pre-wrap text-[13px] font-sans">{text}</pre>
    </section>
  );
}
