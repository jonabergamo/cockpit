import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Pipeline, PipelineRow, RoadAction, Run } from "@cockpit/shared";
import { RefreshButton, useRefreshing } from "../components/RefreshButton";
import { Button, Empty, ErrorNote, Loading, Tag } from "../components/ui";
import { api } from "../lib/api";
import { useSettings } from "../lib/cost";
import { useLive } from "../lib/live";
import { useOpenSession } from "../lib/openSession";
import { useRuns } from "../lib/queries";

export const usePipeline = () => {
  const qc = useQueryClient();
  // where work stands moves with the Board and with runs; a refetch per change is enough
  useLive((ev) => (ev.type === "board" || ev.type === "run") && qc.invalidateQueries({ queryKey: ["pipeline"] }), [qc]);
  return useQuery({ queryKey: ["pipeline"], queryFn: () => api.get<Pipeline>("/pipeline"), refetchInterval: 60_000 });
};

// the buttons core runs itself; a plugin's road can use them too
const CORE = new Set(["pr", "featurepr", "ticket", "session", "board", "epic", "start", "agent", "open", "review"]);

const ALL = "cockpit.pipeline.all";
const readAll = () => {
  try {
    return localStorage.getItem(ALL) === "1";
  } catch {
    return false;
  }
};

// How far along a row is, as a share of its road, so the ones nearest the end come first
const progress = (r: PipelineRow) => r.at / Math.max(1, r.steps.length);

function Steps({ r }: { r: PipelineRow }) {
  if (!r.steps.length) return null;
  return (
    <div className="flex gap-[3px] items-start max-md:w-full">
      {r.steps.map((s, n) => {
        const open = n < r.at ? r.open?.[n] : undefined;
        const look = open !== undefined ? (open === "bad" ? "bg-red" : "bg-ground") : n < r.at ? "bg-green" : n === r.at ? (r.bad ? "bg-red" : "bg-amber") : "bg-ground";
        const now = n === r.at || open === "bad";
        return (
          <div key={n} className="flex flex-col items-center gap-1 w-[60px] max-md:flex-1 max-md:w-auto min-w-0">
            <i className={`block w-full h-1.5 rounded-full ${look}`} />
            <span className={`text-[10.5px] truncate max-w-full ${now ? "text-ink" : "text-faint"}`}>{s}</span>
          </div>
        );
      })}
    </div>
  );
}

function liveRun(r: PipelineRow, runs: Run[]) {
  return runs.find((x) => x.ticket === r.key || (!!r.worktree && !!x.cwd && (x.cwd === r.worktree || x.cwd.startsWith(r.worktree + "/"))));
}

function Row({ r, run, onAct }: { r: PipelineRow; run?: Run; onAct: (r: PipelineRow, a: RoadAction) => Promise<unknown> }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string>();
  const go = (a: RoadAction) => {
    setBusy(a.id);
    onAct(r, a).finally(() => setBusy(undefined));
  };
  const session = r.session && r.kind !== "nocode" && !r.actions.some((a) => a.id === "session");
  const steps = run ? (run.summary?.passed ?? 0) + (run.summary?.failed ?? 0) : 0;
  return (
    <div className={`px-4 py-3 grid grid-cols-[minmax(0,1fr)_auto_230px] max-lg:grid-cols-[minmax(0,1fr)_auto] max-md:grid-cols-1 items-center gap-x-4 gap-y-2 ${r.busy || busy ? "wave" : ""}`}>
      <div className="min-w-0">
        <div className="text-[13px] flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {r.ticket.url ? (
            <a href={r.ticket.url} target="_blank" rel="noreferrer" className="font-mono text-[12px] hover:underline">
              {r.key}
            </a>
          ) : (
            <span className="font-mono text-[12px]">{r.key}</span>
          )}
          {r.kindLabel && <Tag tone="faint">{r.kindLabel}</Tag>}
          <span>{r.ticket.summary}</span>
          {r.badges.map((b, n) =>
            b.href ? (
              <button key={n} onClick={() => (/^https?:/.test(b.href!) ? window.open(b.href, "_blank", "noreferrer") : navigate({ to: b.href! }))} title={b.title}>
                <Tag tone={b.tone ?? "plain"}>{b.label}</Tag>
              </button>
            ) : (
              <Tag key={n} tone={b.tone ?? "plain"} title={b.title}>
                {b.label}
              </Tag>
            ),
          )}
        </div>
        <div className={`text-[12px] mt-1 ${r.needsYou ? "text-amber" : "text-faint"}`}>
          {r.next}
          {r.pr && (
            <>
              {" · "}
              <a href={r.pr.url} target="_blank" rel="noreferrer" className="hover:underline">
                #{r.pr.number}
              </a>
            </>
          )}
          {r.ticket.status && ` · ${r.ticket.status}`}
          {r.node && ` · on ${r.node}`}
          {run && (
            <>
              {" · "}
              <button onClick={() => navigate({ to: "/runs/$id", params: { id: run.id } })} className="text-cobalt font-medium hover:underline" title="Watch it on Runs">
                ● running {run.name || run.kind}
                {steps ? `, step ${steps}` : ""}
              </button>
            </>
          )}
        </div>
      </div>
      <Steps r={r} />
      <div className="flex flex-wrap gap-1.5 justify-end max-lg:col-span-full max-lg:justify-start">
        {session && (
          <Button size="sm" onClick={() => navigate({ to: "/sessions/$id", params: { id: r.session!.id }, search: { agent: undefined } })}>
            Session
          </Button>
        )}
        {r.actions.map((a) => (
          <Button key={a.id} size="sm" variant={a.primary ? "primary" : "default"} disabled={busy === a.id} onClick={() => go(a)}>
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

// Each of your tickets on the road its kind takes, with the step that moves it on, grouped by whether it needs you
export function PipelineList() {
  const q = usePipeline();
  const refreshing = useRefreshing(["pipeline"]);
  const runs = useRuns({ status: "running", limit: 50 }).data ?? [];
  const prompts = useSettings().data?.settings.pipeline;
  const openSession = useOpenSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [all, setAll] = useState(readAll);
  const [note, setNote] = useState<{ text: string; to?: string; label?: string }>();
  const [err, setErr] = useState<unknown>();

  const toggleAll = (v: boolean) => {
    setAll(v);
    try {
      localStorage.setItem(ALL, v ? "1" : "0");
    } catch {}
  };

  const open = (to: string) => (/^https?:/.test(to) ? window.open(to, "_blank", "noreferrer") : navigate({ to }));

  async function act(r: PipelineRow, a: RoadAction) {
    setErr(undefined);
    try {
      if (a.href) return open(a.href);
      // the ids core knows are its own, on a plugin's road too
      const plugin = CORE.has(a.id) ? undefined : (a.plugin ?? r.plugin);
      if (plugin) {
        const res = await api.post<{ term?: string; runId?: string; note?: string; link?: string }>("/pipeline/act", { plugin, action: a.id, key: r.key });
        await qc.invalidateQueries({ queryKey: ["pipeline"] });
        if (res.runId) return navigate({ to: "/runs/$id", params: { id: res.runId } });
        if (res.term) return navigate({ to: "/terminals", search: { id: res.term } });
        if (res.note) setNote({ text: res.note, to: res.link, label: "Follow it" });
        else if (res.link) open(res.link);
        return;
      }
      switch (a.id) {
        case "pr":
          return r.pr && open(r.pr.url);
        case "featurepr":
          return r.featurePr && open(r.featurePr.url);
        case "ticket":
          return r.ticket.url && open(r.ticket.url);
        case "session":
          return r.session && navigate({ to: "/sessions/$id", params: { id: r.session.id }, search: { agent: undefined } });
        case "board":
          return navigate({ to: "/board", search: { view: "board", card: r.card } });
        case "epic":
          return navigate({ to: "/tickets", search: { key: r.key, tab: undefined } });
        case "start":
          await api.post("/tasks", { title: r.ticket.summary, ticket: r.key });
          await qc.invalidateQueries({ queryKey: ["pipeline"] });
          return setNote({ text: `${r.key} is queued: cockpit makes its worktree and starts its agent on it.`, to: "/board?view=tasks", label: "Queue" });
        case "agent": {
          const t = await api.post<{ id: string }>("/claude/launch", { cwd: r.worktree, ticket: r.key, title: r.key, node: r.node });
          return navigate({ to: "/terminals", search: { id: t.id } });
        }
        case "open":
        case "review": {
          if (!r.session) return;
          const text = (a.id === "open" ? prompts?.openPrompt : prompts?.reviewPrompt)?.replace(/\{pr\}/g, String(r.pr?.number ?? ""));
          if (!text) return;
          const { sent } = await api.post<{ sent: boolean }>(`/sessions/${r.session.id}/send`, { text });
          if (sent) return setNote({ text: `Sent to ${r.key}'s session.`, to: `/sessions/${r.session.id}`, label: "Watch it" });
          // not running where cockpit can type into it: resumed in a terminal, with the message
          return openSession({ id: r.session.id }, text);
        }
      }
    } catch (e) {
      setErr(e);
    }
  }

  if (q.isLoading) return <Loading what="Reading tickets, worktrees, PRs and the Board" rows={6} />;
  const rows = (q.data?.rows ?? []).filter((r) => all || r.ticket.inSprint);
  const groups: [string, PipelineRow[]][] = [
    ["Needs you", rows.filter((r) => r.needsYou)],
    ["In motion", rows.filter((r) => !r.needsYou && !r.shipping && r.kind !== "nocode")],
    ["Shipping or done", rows.filter((r) => !r.needsYou && r.shipping)],
    ["Not code", rows.filter((r) => r.kind === "nocode" && !r.needsYou)],
  ];
  const warnings = q.data?.warnings ?? [];

  return (
    <div className={`space-y-4 max-w-[1150px] ${refreshing ? "wave" : ""}`}>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input type="checkbox" checked={all} onChange={(e) => toggleAll(e.target.checked)} className="size-4 accent-[var(--cobalt)]" />
          Tickets outside the sprint
        </label>
        <span className="flex-1" />
        <RefreshButton targets={[{ key: ["pipeline"], url: "/pipeline" }]} />
      </div>
      <ErrorNote error={q.error ?? err} />
      {!!warnings.length && (
        <div className="bg-panel border border-amber/50 rounded-lg px-4 py-3 text-[13px] space-y-1">
          <div className="flex items-center gap-2">
            <span className="flex-1 font-medium">Some of what this reads is missing</span>
            {warnings.some((w) => w.plugin) && (
              <Button size="sm" onClick={() => navigate({ to: "/settings", search: { tab: "plugins" } })}>
                Plugins
              </Button>
            )}
          </div>
          <ul className="list-disc pl-5 text-muted">
            {warnings.map((w, n) => (
              <li key={n}>{w.text}</li>
            ))}
          </ul>
        </div>
      )}
      {note && (
        <div className="bg-panel border border-line rounded-lg px-4 py-2.5 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="flex-1 min-w-0">{note.text}</span>
          {note.to && (
            <Button size="sm" onClick={() => open(note.to!)}>
              {note.label ?? "Open"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setNote(undefined)}>
            Dismiss
          </Button>
        </div>
      )}
      {!rows.length ? (
        <Empty>{all ? "No tickets." : "No sprint tickets. Tick Tickets outside the sprint to see the rest."}</Empty>
      ) : (
        groups
          .filter(([, list]) => list.length)
          .map(([name, list]) => (
            <section key={name} className="bg-panel border border-line rounded-lg">
              <h2 className={`font-semibold text-[13px] px-4 pt-3 pb-2 ${name === "Needs you" ? "text-amber" : ""}`}>
                {name} <span className="text-faint font-normal">{list.length}</span>
              </h2>
              <div className="divide-y divide-line">
                {[...list]
                  .sort((a, b) => progress(b) - progress(a))
                  .map((r) => (
                    <Row key={r.key} r={r} run={liveRun(r, runs)} onAct={act} />
                  ))}
              </div>
            </section>
          ))
      )}
    </div>
  );
}
