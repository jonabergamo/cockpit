import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Entry, Session, Subagent } from "@cockpit/shared";
import { ReplyPanel } from "../components/ReplyPanel";
import { Timeline } from "../components/Timeline";
import { Scrubber } from "../components/Scrubber";
import { Button, copy, ErrorNote, Loading, Tag } from "../components/ui";
import { api, qs } from "../lib/api";
import { ago, shortPath, usd } from "../lib/format";
import { useCost } from "../lib/cost";
import { keep, send, useLive, useLiveSessions } from "../lib/live";
import { place, placeLabel } from "../lib/nav";
import { useOpenSession } from "../lib/openSession";
import { useAppConfig } from "../lib/queries";
import { statusLook } from "../lib/status";
import { useTerms } from "./Terminals";

interface Tail {
  entries: Entry[];
  offset: number;
  truncated: boolean;
}

function useTranscript(sessionId: string, agent?: string) {
  const [bytes, setBytes] = useState(3 * 1024 * 1024);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cost, setCost] = useState<Extract<Entry, { kind: "cost" }>>();
  const q = useQuery({
    queryKey: ["entries", sessionId, agent, bytes],
    queryFn: () => api.get<Tail>(`/sessions/${sessionId}/entries${qs({ agent, bytes })}`),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!q.data) return;
    setEntries(q.data.entries.filter((e) => e.kind !== "cost"));
    setCost([...q.data.entries].reverse().find((e) => e.kind === "cost") as never);
    const key = `watch:${sessionId}:${agent ?? ""}`;
    keep(key, { type: "watch", sessionId, agentId: agent, offset: q.data.offset });
    return () => {
      keep(key, null);
      send({ type: "unwatch", sessionId, agentId: agent });
    };
  }, [q.data, sessionId, agent]);

  useLive(
    (ev) => {
      if (ev.type !== "entries" || ev.sessionId !== sessionId || (ev.agentId ?? undefined) !== agent) return;
      const fresh = ev.entries.filter((e) => e.kind !== "cost");
      const c = [...ev.entries].reverse().find((e) => e.kind === "cost");
      if (c) setCost(c as never);
      if (fresh.length) setEntries((prev) => [...prev, ...fresh]);
    },
    [sessionId, agent],
  );

  return { ...q, entries, cost, truncated: q.data?.truncated, more: () => setBytes((b) => b * 4) };
}

export function SessionPage() {
  const cost = useCost();
  const { id } = useParams({ from: "/sessions/$id" });
  const { agent } = useSearch({ from: "/sessions/$id" });
  const live = useLiveSessions().find((s) => s.id === id);
  const session = useQuery({ queryKey: ["session", id], queryFn: () => api.get<Session>(`/sessions/${id}`), refetchInterval: live ? 5000 : false });
  const agents = useQuery({ queryKey: ["agents", id], queryFn: () => api.get<Subagent[]>(`/sessions/${id}/agents`), refetchInterval: live ? 5000 : false });
  const t = useTranscript(id, agent);
  const [err, setErr] = useState<unknown>();
  const router = useRouter();
  const screens = useAppConfig().data?.screens;
  // back to wherever the session was opened from, kept as it was then; Sessions when there's nowhere
  const [back] = useState(() => {
    const p = place.get();
    if (!p || p.href === "/sessions") return undefined;
    return { href: p.href, label: placeLabel(p.path, p.href.split("?")[1] ?? "", screens) };
  });

  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [t.entries.length]);

  const s = { ...session.data, ...live } as Session | undefined;
  const status = live?.status ?? s?.status;
  const currentAgent = agents.data?.find((a) => a.id === agent);

  // the session may already be running in one of cockpit's terminals: claude's pid is the pty's own process
  const terms = useTerms();
  const ownTerm = terms.data?.find((x) => x.exited === undefined && (x.session === id || (!!s?.pid && x.pid === s.pid)));

  const openSession = useOpenSession();
  const resume = async () => {
    if (!ownTerm && status !== "ended" && !confirm("This session is still open in another terminal. Resume a second copy of it here?")) return;
    try {
      await openSession({ id, pid: s?.pid });
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <div className="flex gap-5 max-w-[1400px]">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-start gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-[13px] text-muted mb-1">
              {back ? (
                <a
                  href={back.href}
                  onClick={(e) => {
                    e.preventDefault();
                    router.history.push(back.href);
                  }}
                  className="hover:text-ink"
                >
                  {back.label}
                </a>
              ) : (
                <Link to="/sessions" className="hover:text-ink">
                  Sessions
                </Link>
              )}
              {agent && (
                <>
                  <span>/</span>
                  <Link to="/sessions/$id" params={{ id }} search={{ agent: undefined }} className="hover:text-ink truncate">
                    {s?.title ?? id.slice(0, 8)}
                  </Link>
                </>
              )}
            </div>
            <h1 className="text-[22px] font-semibold tracking-tight leading-tight">{agent ? (currentAgent?.description ?? `Agent ${agent}`) : (s?.title ?? s?.name ?? id)}</h1>
            <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[13px] text-muted">
              {status && <Tag tone={status === "busy" ? "cobalt" : status === "waiting" ? "amber" : "faint"}>{statusLook(status, s?.waitingFor, s?.background).label}</Tag>}
              {s?.ticket && (
                <Link to="/tickets" search={{ key: s.ticket }} className="text-cobalt hover:underline">
                  {s.ticket}
                </Link>
              )}
              {s?.cwd && <span>{s.node ? `${s.node}: ` : ""}{shortPath(s.cwd)}</span>}
              {s?.branch && <span className="font-mono text-[12px]">{s.branch}</span>}
              {s?.updatedAt ? <span>{ago(s.updatedAt)}</span> : null}
            </div>
          </div>
          {!agent && s?.cwd && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={resume} title={ownTerm ? "It's already running in a cockpit terminal" : `claude --resume ${id}`}>
                {ownTerm ? "Open its terminal" : "Resume in terminal"}
              </Button>
              {s.worktree && (
                <Link to="/code" search={{ root: s.worktree }}>
                  <Button>Open code</Button>
                </Link>
              )}
              <Button variant="ghost" onClick={() => copy(`claude --resume ${id}`)}>
                Copy resume command
              </Button>
            </div>
          )}
        </div>
        <ErrorNote error={err} />
        <Scrubber entries={t.entries} scroller={scroller} />

        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className={`${status && status !== "ended" ? "h-[calc(100vh-385px)]" : "h-[calc(100vh-285px)]"} overflow-y-auto pr-2`}
        >
          {t.truncated && (
            <div className="text-center mb-3">
              <Button size="sm" variant="ghost" onClick={t.more}>
                Load earlier messages
              </Button>
            </div>
          )}
          {t.isLoading ? <Loading what="Reading transcript" /> : <Timeline entries={t.entries} agents={agents.data} sessionId={id} />}
          <ErrorNote error={t.error} />
          {status === "busy" && <div className="text-cobalt text-[13px] mt-3 animate-pulse">Claude is working</div>}
        </div>
        {s?.id && status && status !== "ended" && (
          <div className="border-t border-line pt-3 mt-2">
            <ReplyPanel session={{ ...s, status }} compact />
          </div>
        )}
      </div>

      <aside className="hidden lg:block w-[280px] shrink-0 space-y-4">
        <div className="bg-panel border border-line rounded-lg p-3 text-[13px] space-y-1.5">
          {!cost.hidden && <Row label={cost.label} value={usd(t.cost?.costUSD ?? s?.costUSD)} />}
          <Row label="Lines" value={t.cost || s?.linesAdded !== undefined ? `+${t.cost?.linesAdded ?? s?.linesAdded ?? 0} −${t.cost?.linesRemoved ?? s?.linesRemoved ?? 0}` : ""} />
          {t.cost &&
            Object.entries(t.cost.models).map(([m, u]) => (
              <Row key={m} label={m.replace("claude-", "")} value={`${cost.hidden ? "" : `${usd(u.costUSD)} · `}${Math.round((u.outputTokens ?? 0) / 1000)}k out`} />
            ))}
          {s?.pid && <Row label="PID" value={String(s.pid)} />}
          <Row label="Session" value={id.slice(0, 8)} />
        </div>
        {!!agents.data?.length && (
          <div className="bg-panel border border-line rounded-lg">
            <h3 className="px-3 h-9 flex items-center font-semibold border-b border-line">Subagents</h3>
            <ul className="max-h-[60vh] overflow-y-auto">
              {agents.data.map((a) => (
                <li key={a.id}>
                  <Link
                    to="/sessions/$id"
                    params={{ id }}
                    search={{ agent: a.id }}
                    className={`block px-3 py-1.5 hover:bg-ground ${agent === a.id ? "bg-cobalt-soft" : ""}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`size-1.5 rounded-full ${a.finished ? "bg-green" : "bg-cobalt animate-pulse"}`} />
                      <span className="truncate text-[13px]">{a.description || a.id}</span>
                    </div>
                    <div className="text-[12px] text-muted truncate">
                      {a.type}
                      {a.workflowRun ? ` · ${a.phase ?? a.workflowRun}` : ""}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

const Row = ({ label, value }: { label: string; value?: string }) =>
  value ? (
    <div className="flex gap-2">
      <span className="text-muted flex-1 truncate">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  ) : null;
