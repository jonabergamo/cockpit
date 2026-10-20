import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Session, Worktree } from "@cockpit/shared";
import { PrFix } from "../components/PrFix";
import { SetupBanner } from "../components/SetupSection";
import { RefreshButton } from "../components/RefreshButton";
import { Button, Empty, ErrorNote, Loading, StatusTag, Tag } from "../components/ui";
import { api } from "../lib/api";
import { ago, shortPath, time, today, usd } from "../lib/format";
import { useCost } from "../lib/cost";
import { useLiveSessions } from "../lib/live";
import { useAppConfig, usePrs, useWorktrees } from "../lib/queries";
import { PrBadge, useTickets } from "./Tickets";

interface DayRes {
  date: string;
  sessions: Session[];
  commits: { sha: string; subject: string; at: string; ticket?: string }[];
  costUSD: number;
}

interface ReportLite {
  totals: { scope: number; released: number; projected: number; daysLeft: number };
  sprint: { name: string };
}

// Hours 7 to 21 laid out left to right, with each session as a bar and commits as ticks.
function DayStrip({ day }: { day: DayRes }) {
  const start = new Date(`${day.date}T07:00:00`).getTime();
  const end = new Date(`${day.date}T21:00:00`).getTime();
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100));
  const hours = Array.from({ length: 8 }, (_, i) => 7 + i * 2);
  const sessions = day.sessions.filter((s) => s.updatedAt - s.startedAt > 60_000).slice(0, 12);

  return (
    <div>
      <div className="relative h-5 text-[11px] text-faint">
        {hours.map((h) => (
          <span key={h} className="absolute -translate-x-1/2" style={{ left: `${((h - 7) / 14) * 100}%` }}>
            {h}:00
          </span>
        ))}
      </div>
      <div className="space-y-1">
        {sessions.map((s) => {
          const l = pct(s.startedAt);
          const w = Math.max(pct(s.updatedAt) - l, 0.8);
          return (
            <Link key={s.id} to="/sessions/$id" params={{ id: s.id }} className="relative block h-5 bg-ground rounded group" title={`${s.title ?? s.id}\n${time(s.startedAt)} to ${time(s.updatedAt)}`}>
              <span
                className={`absolute top-0 bottom-0 rounded-[4px] ${s.status === "busy" ? "bg-cobalt" : s.status === "idle" ? "bg-amber" : "bg-cobalt/45"} group-hover:brightness-110`}
                style={{ left: `${l}%`, width: `${w}%` }}
              />
              <span className="absolute inset-y-0 left-1.5 flex items-center text-[11px] text-ink/80 truncate max-w-[60%] pointer-events-none">{s.title ?? shortPath(s.cwd)}</span>
            </Link>
          );
        })}
        <div className="relative h-4">
          {day.commits.map((c) => (
            <span key={c.sha} title={`${time(c.at)} ${c.subject}`} className="absolute top-0 bottom-0 w-[3px] rounded-full bg-green" style={{ left: `${pct(Date.parse(c.at))}%` }} />
          ))}
        </div>
      </div>
      {!sessions.length && !day.commits.length && <div className="text-muted text-[13px]">Nothing yet today.</div>}
    </div>
  );
}

export function TodayPage() {
  const cost = useCost();
  const live = useLiveSessions();
  const tickets = useTickets();
  const prs = usePrs();
  const wts = useWorktrees();
  const navigate = useNavigate();
  const day = useQuery({ queryKey: ["day", today()], queryFn: () => api.get<DayRes>("/report/day") });
  const cfg = useAppConfig();
  const tracker = cfg.data?.tracker;
  const codeHost = cfg.data?.codeHost;
  const report = useQuery({ queryKey: ["report", undefined, "me"], queryFn: () => api.get<ReportLite>("/report/sprint?scope=me"), enabled: !!tracker });
  const openEditor = useMutation({ mutationFn: (path: string) => api.post("/worktrees/open", { path }) });

  const waiting = live.filter((s) => s.status === "idle");
  const failing = prs.data?.mine.filter((p) => p.state === "OPEN" && p.checks === "fail") ?? [];
  const reviews = prs.data?.review ?? [];
  const wtBy = new Map<string, Worktree>();
  for (const w of wts.data ?? []) if (w.ticket && !w.main) wtBy.set(w.ticket, w);
  // by the tracker's status category when it gives one, else by name
  const active = tickets.data?.tickets.filter((t) => t.inSprint && (t.statusCategory ? t.statusCategory === "indeterminate" : /progress|review|qa/i.test(t.status))) ?? [];
  const next = tickets.data?.tickets.filter((t) => t.inSprint && (t.statusCategory ? t.statusCategory === "new" : /to do/i.test(t.status))) ?? [];
  const r = report.data;

  const hello = new Date().getHours() < 12 ? "Morning" : new Date().getHours() < 18 ? "Afternoon" : "Evening";

  return (
    <div className="max-w-[1200px] space-y-5">
      <SetupBanner />
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <h1 className="text-[26px] font-semibold tracking-tight">{hello}.</h1>
          <p className="text-muted">
            {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
            {day.data ? ` · ${day.data.commits.length} commits${cost.hidden ? "" : ` and ${usd(day.data.costUSD) || "$0"} ${cost.real ? "of Claude" : "of API value"}`} so far` : ""}
          </p>
        </div>
        <RefreshButton
          targets={[
            ...(tracker ? [{ key: ["tickets"], url: "/tickets" }, { key: ["report", undefined, "me"] }] : []),
            ...(codeHost ? [{ key: ["prs"], url: "/prs" }] : []),
            { key: ["worktrees"] },
            { key: ["day"] },
          ]}
        />
        {r && (
          <Link to="/report" search={{ sprint: undefined }} className="bg-panel border border-line rounded-lg px-4 py-2.5 hover:border-faint min-w-[260px]">
            <div className="flex items-baseline gap-2">
              <span className="text-[22px] font-semibold">{r.totals.released}</span>
              <span className="text-muted">of {r.totals.scope} points released</span>
            </div>
            <div className="h-1.5 rounded-full bg-ground mt-1.5 overflow-hidden">
              <div className="h-full bg-cobalt rounded-full" style={{ width: `${r.totals.scope ? (r.totals.released / r.totals.scope) * 100 : 0}%` }} />
            </div>
            <div className="text-[12px] text-muted mt-1">
              {r.sprint.name}, {r.totals.daysLeft} workdays left
            </div>
          </Link>
        )}
      </div>

      <div className="grid lg:grid-cols-[1fr_380px] gap-5 items-start">
        <div className="space-y-5 min-w-0">
          {tracker && (
          <section className="bg-panel border border-line rounded-lg">
            <h2 className="font-semibold px-4 pt-3 pb-2">In flight</h2>
            {tickets.isLoading && <Loading what={`Asking ${tracker.name}`} />}
            <ErrorNote error={tickets.error} />
            <div className="divide-y divide-line">
              {active.map((t) => {
                const wt = wtBy.get(t.key);
                const pr = prs.data?.mine.find((p) => p.ticket === t.key && p.state !== "CLOSED");
                const sessions = live.filter((s) => s.ticket === t.key);
                return (
                  <div key={t.key} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Link to="/tickets" search={{ key: t.key }} className="flex-1 min-w-[260px] hover:text-cobalt">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{t.key}</span>
                        <StatusTag status={t.status} category={t.statusCategory} />
                        {sessions.map((s) => (
                          <Tag key={s.id} tone={s.status === "busy" ? "cobalt" : "amber"}>
                            Claude {s.status === "busy" ? "working" : "waiting"}
                          </Tag>
                        ))}
                      </div>
                      <div className="text-[13px] text-muted truncate">{t.summary}</div>
                    </Link>
                    {pr && <PrBadge pr={pr} />}
                    {pr && <PrFix pr={pr} />}
                    {wt ? (
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="primary" onClick={() => openEditor.mutate(wt.path)}>
                          VS Code
                        </Button>
                        <Button size="sm" onClick={() => navigate({ to: "/code", search: { root: wt.path } })}>
                          Code
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" onClick={() => navigate({ to: "/tickets", search: { key: t.key } })}>
                        Set up worktree
                      </Button>
                    )}
                  </div>
                );
              })}
              {!tickets.isLoading && !active.length && <Empty>Nothing in progress. Pick something from up next.</Empty>}
            </div>
            <ErrorNote error={openEditor.error} />
          </section>
          )}

          <section className="bg-panel border border-line rounded-lg p-4">
            <h2 className="font-semibold mb-2">My day</h2>
            {day.data ? <DayStrip day={day.data} /> : <Loading />}
          </section>

          {next.length > 0 && (
            <section className="bg-panel border border-line rounded-lg">
              <h2 className="font-semibold px-4 pt-3 pb-2">Up next in the sprint</h2>
              <div className="divide-y divide-line">
                {next.map((t) => (
                  <Link key={t.key} to="/tickets" search={{ key: t.key }} className="flex items-center gap-3 px-4 py-2 hover:bg-ground">
                    <span className="font-medium w-24 shrink-0">{t.key}</span>
                    <span className="flex-1 truncate text-[13px]">{t.summary}</span>
                    <span className="text-[12px] text-muted">{t.points ?? "?"} pt</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="space-y-5">
          <section className="bg-panel border border-line rounded-lg">
            <h2 className="font-semibold px-4 pt-3 pb-2">Needs you</h2>
            <div className="divide-y divide-line">
              {waiting.map((s) => (
                <Link key={s.id} to="/sessions/$id" params={{ id: s.id }} className="block px-4 py-2 hover:bg-ground">
                  <div className="flex items-center gap-2">
                    <span className="size-2 rounded-full bg-amber shrink-0" />
                    <span className="truncate flex-1 text-[13px] font-medium">{s.title ?? s.name ?? shortPath(s.cwd)}</span>
                    <span className="text-[12px] text-muted">{ago(s.updatedAt)}</span>
                  </div>
                  <div className="text-[12px] text-muted pl-4 truncate">Claude is waiting · {shortPath(s.cwd)}</div>
                </Link>
              ))}
              {failing.map((p) => (
                <div key={p.number} className="flex items-center gap-2 px-4 py-2 hover:bg-ground">
                  <a href={p.url} target="_blank" rel="noreferrer" className="flex-1 min-w-0 flex items-center gap-2 text-[13px]">
                    <Tag tone="red">checks failing</Tag>
                    <span className="truncate">#{p.number} {p.title}</span>
                  </a>
                  <PrFix pr={p} />
                </div>
              ))}
              {reviews.map((p) => (
                <div key={p.number} className="flex items-center gap-2 px-4 py-2 hover:bg-ground">
                  <a href={p.url} target="_blank" rel="noreferrer" className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-[13px]">
                      <Tag tone="amber">review</Tag>
                      <span className="truncate">#{p.number} {p.title}</span>
                    </div>
                    <div className="text-[12px] text-muted pl-1">
                      {p.author} · {ago(p.createdAt)}
                    </div>
                  </a>
                  <Link to="/reviews" search={{ pr: p.url }}>
                    <Button size="sm">Review</Button>
                  </Link>
                </div>
              ))}
              {!waiting.length && !failing.length && !reviews.length && <div className="px-4 py-3 text-[13px] text-muted">All clear. No session is waiting, no checks are failing, no reviews requested.</div>}
            </div>
          </section>

          {codeHost && (
          <section className="bg-panel border border-line rounded-lg">
            <h2 className="font-semibold px-4 pt-3 pb-2">My open PRs</h2>
            <div className="divide-y divide-line">
              {prs.data?.mine
                .filter((p) => p.state === "OPEN")
                .map((p) => (
                  <div key={p.number} className="flex items-center gap-2 px-4 py-2 hover:bg-ground text-[13px]">
                    <a href={p.url} target="_blank" rel="noreferrer" className="truncate flex-1">
                      {p.title}
                    </a>
                    {p.checks !== "fail" && <PrFix pr={p} />}
                    <PrBadge pr={p} />
                  </div>
                ))}
            </div>
          </section>
          )}
        </div>
      </div>
    </div>
  );
}
