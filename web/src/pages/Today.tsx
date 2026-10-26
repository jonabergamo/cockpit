import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { BoardCard, Session } from "@cockpit/shared";
import { AwayDigest } from "../components/AwayDigest";
import { Overnight } from "../components/Overnight";
import { SetupBanner } from "../components/SetupSection";
import { RefreshButton, useRefreshing } from "../components/RefreshButton";
import { ErrorNote, Loading } from "../components/ui";
import { api } from "../lib/api";
import { shortPath, time, today, usd } from "../lib/format";
import { useCost } from "../lib/cost";
import { useAppConfig, usePrs } from "../lib/queries";
import { useBoard } from "./Board";
import { useTickets } from "./Tickets";
import { useAgentName, useClaudeMain } from "../lib/agent";

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
                className={`absolute top-0 bottom-0 rounded-[4px] ${s.status === "busy" ? "bg-cobalt" : s.status === "waiting" ? "bg-amber" : "bg-cobalt/45"} group-hover:brightness-110`}
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

const SHOWN = 4;

// What's in flight, in a line: how much sits in each of Work's columns, and the first few that need you.
// The lists themselves live on Work.
function WorkSummary() {
  const agent = useAgentName();
  const board = useBoard();
  const prs = usePrs();
  const refreshing = useRefreshing(["board"], ["prs"]);
  const codeHost = useAppConfig().data?.codeHost;
  const cards = board.data ?? [];
  const count = (col: BoardCard["column"]) => cards.filter((c) => c.column === col).length;
  const needs = cards.filter((c) => c.column === "needs");
  const tiles: { n: number; label: string; tone: string; to: "/board" | "/reviews"; filter?: "tasks" }[] = [
    { n: needs.length, label: "need you", tone: needs.length ? "text-amber" : "", to: "/board" },
    { n: count("working"), label: "working", tone: count("working") ? "text-cobalt" : "", to: "/board" },
    { n: count("review"), label: "in review", tone: "", to: "/board" },
    { n: count("ready"), label: "ready to merge", tone: count("ready") ? "text-green" : "", to: "/board" },
    { n: count("queued"), label: "queued", tone: "", to: "/board", filter: "tasks" },
    ...(codeHost ? [{ n: prs.data?.review.length ?? 0, label: "reviews for you", tone: prs.data?.review.length ? "text-amber" : "", to: "/reviews" as const }] : []),
  ];

  return (
    <section className={`bg-panel border border-line rounded-lg ${refreshing ? "wave" : ""}`}>
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="font-semibold flex-1">In flight</h2>
        <Link to="/board" className="text-[13px] text-cobalt hover:underline">
          Open Work
        </Link>
      </div>
      {board.isLoading && <Loading what="Gathering sessions, worktrees and PRs" rows={2} />}
      {board.error && (
        <div className="px-4 pb-3">
          <ErrorNote error={board.error} />
        </div>
      )}
      {board.data && (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-6 border-t border-line divide-x divide-line">
            {tiles.map((t) =>
              t.to === "/reviews" ? (
                <Link key={t.label} to="/reviews" className="px-4 py-2.5 hover:bg-ground">
                  <div className={`text-[20px] font-semibold tabular-nums ${t.tone}`}>{t.n}</div>
                  <div className="text-[12px] text-muted">{t.label}</div>
                </Link>
              ) : (
                <Link key={t.label} to="/board" search={{ filter: t.filter }} className="px-4 py-2.5 hover:bg-ground">
                  <div className={`text-[20px] font-semibold tabular-nums ${t.tone}`}>{t.n}</div>
                  <div className="text-[12px] text-muted">{t.label}</div>
                </Link>
              ),
            )}
          </div>
          {needs.length > 0 && (
            <div className="divide-y divide-line border-t border-line">
              {needs.slice(0, SHOWN).map((c) => (
                <Link key={c.id} to="/board" search={{ card: c.id }} className="flex items-center gap-2 px-4 py-2 hover:bg-ground text-[13px]">
                  <span className="size-2 rounded-full bg-amber shrink-0" />
                  {c.ticket && <span className="font-mono text-[12px] shrink-0">{c.ticket}</span>}
                  <span className="truncate flex-1">{c.title}</span>
                  <span className="text-[12px] text-amber truncate max-w-[45%]">{c.stuck ? `Stuck: ${c.stuck}` : c.reason}</span>
                </Link>
              ))}
              {needs.length > SHOWN && (
                <Link to="/board" className="block px-4 py-2 text-[13px] text-muted hover:bg-ground">
                  {needs.length - SHOWN} more on Work
                </Link>
              )}
            </div>
          )}
          {!cards.length && <div className="px-4 py-3 text-[13px] text-muted border-t border-line">Nothing in flight. Start {agent} in a worktree, or queue a task.</div>}
        </>
      )}
    </section>
  );
}

export function TodayPage() {
  // the dollars are Claude Code's; another main agent's tokens show on its sessions
  const claudeMain = useClaudeMain();
  const cost = useCost();
  const tickets = useTickets();
  const day = useQuery({ queryKey: ["day", today()], queryFn: () => api.get<DayRes>("/report/day") });
  const refreshing = useRefreshing(["day"], ["tickets"]);
  const cfg = useAppConfig();
  const tracker = cfg.data?.tracker;
  const codeHost = cfg.data?.codeHost;
  const report = useQuery({ queryKey: ["report", undefined, "me"], queryFn: () => api.get<ReportLite>("/report/sprint?scope=me"), enabled: !!tracker });

  // by the tracker's status category when it gives one, else by name
  const next = tickets.data?.tickets.filter((t) => t.inSprint && (t.statusCategory ? t.statusCategory === "new" : /to do/i.test(t.status))) ?? [];
  const r = report.data;

  const hello = new Date().getHours() < 12 ? "Morning" : new Date().getHours() < 18 ? "Afternoon" : "Evening";

  return (
    <div className="max-w-[1200px] space-y-5">
      <SetupBanner />
      <AwayDigest />
      <Overnight />
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <h1 className="text-[26px] font-semibold tracking-tight">{hello}.</h1>
          <p className="text-muted">
            {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
            {day.data ? ` · ${day.data.commits.length} commits${cost.hidden || !claudeMain ? "" : ` and ${usd(day.data.costUSD) || "$0"} ${cost.real ? "of Claude" : "of API value"}`} so far` : ""}
          </p>
        </div>
        <RefreshButton
          targets={[
            ...(tracker ? [{ key: ["tickets"], url: "/tickets" }, { key: ["report", undefined, "me"] }] : []),
            ...(codeHost ? [{ key: ["prs"], url: "/prs" }] : []),
            { key: ["board"] },
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

      <WorkSummary />

      <div className={`grid gap-5 items-start ${next.length ? "lg:grid-cols-[1fr_380px]" : ""}`}>
        <section className={`bg-panel border border-line rounded-lg p-4 min-w-0 ${refreshing ? "wave" : ""}`}>
          <h2 className="font-semibold mb-2">My day</h2>
          {day.data ? <DayStrip day={day.data} /> : day.isLoading ? <Loading /> : <ErrorNote error={day.error} />}
        </section>

        {next.length > 0 && (
          <section className={`bg-panel border border-line rounded-lg ${refreshing ? "wave" : ""}`}>
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
    </div>
  );
}
