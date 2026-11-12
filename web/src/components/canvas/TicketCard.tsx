import { type Node, type NodeProps } from "@xyflow/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Epic, KitsRes, PullRequest, Ticket } from "@cockpit/shared";
import { useAgentName } from "../../lib/agent";
import { api, qs } from "../../lib/api";
import { ago } from "../../lib/format";
import { useOpenSession } from "../../lib/openSession";
import { useJobs, usePrs, useTickets, useWorktrees } from "../../lib/queries";
import { PrBadge } from "../../pages/Tickets";
import { PrFix } from "../PrFix";
import { Button, StatusTag, Tag } from "../ui";
import { useActions } from "./context";
import { useFit } from "./fit";
import { Ports } from "./LinkEdge";

// an open PR's checks: running, passed or failing (the PR badge already says when it's failing; this says it for all)
function Checks({ pr }: { pr: PullRequest }) {
  if (pr.state !== "OPEN" || !pr.checks || pr.checks === "none") return null;
  const look = { pass: ["text-green", "✓", "checks pass"], fail: ["text-red", "✗", "checks fail"], pending: ["text-amber", "●", "checks running"] }[pr.checks];
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] ${look[0]}`} title={pr.ignoredFailing ? `Failing but ignored in Settings: ${pr.ignoredFailing.join(", ")}` : undefined}>
      <span className={pr.checks === "pending" ? "animate-pulse" : ""}>{look[1]}</span>
      {look[2]}
    </span>
  );
}

export type TicketData = { key: string; terms: number; fit?: boolean };
export type TicketCardNode = Node<TicketData, "ticket">;

// One of your tickets, from the list cockpit already has; anyone else's (a teammate's) is looked up on its own.
// refresh asks the tracker again for both.
function useTicket(key: string) {
  const qc = useQueryClient();
  const list = useTickets();
  const mine = [...(list.data?.tickets ?? []), ...(list.data?.epics ?? [])].find((x) => x.key === key) as Ticket | Epic | undefined;
  const other = useQuery({ queryKey: ["ticket-lookup", key], queryFn: () => api.get<Ticket[]>(`/tickets/lookup${qs({ keys: key })}`).then((r) => r[0] ?? null), enabled: !!list.data && !mine, staleTime: 10 * 60_000 });
  const refresh = useMutation({
    mutationFn: async () => {
      const [fresh] = await api.get<Ticket[]>(`/tickets/lookup${qs({ keys: key, fresh: "1" })}`);
      qc.setQueryData(["ticket-lookup", key], fresh ?? null);
      await qc.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
  return { t: mine ?? other.data ?? undefined, mine: !!mine, loading: other.isLoading && !mine, refresh };
}

// A ticket on the canvas: where it stands in the tracker, its worktree and PRs, and the way to start on it. The
// terminals working on it hang off it by a line.
export function TicketCard({ id, data, selected }: NodeProps<TicketCardNode>) {
  const a = useActions();
  const agent = useAgentName();
  const qc = useQueryClient();
  const openSession = useOpenSession();
  const { t, mine, loading, refresh } = useTicket(data.key);
  const wt = useWorktrees().data?.find((w) => w.ticket === data.key && !w.main);
  const prs = (usePrs().data?.mine ?? []).filter((p) => p.ticket === data.key && p.state !== "CLOSED");
  const jobs = useJobs();
  const [jobId, setJobId] = useState<string>();
  const job = jobs.data?.find((j) => j.id === jobId);
  const creating = !!jobId && job?.code === undefined;

  const create = useMutation({ mutationFn: () => api.post<{ id: string }>("/worktrees", { key: data.key, summary: t?.summary ?? data.key, type: t?.type }), onSuccess: (j) => setJobId(j.id) });
  // once the worktree is made, it shows here with the button to start on it
  useEffect(() => {
    if (job?.code === undefined) return;
    qc.invalidateQueries({ queryKey: ["worktrees"] });
    qc.invalidateQueries({ queryKey: ["roots"] });
  }, [job?.code, qc]);
  // the ticket link alone is enough for a ticket-to-PR skill to pick it up; the terminal lands beside this card
  const start = useMutation({
    mutationFn: () => api.post<{ id: string }>("/claude/launch", { cwd: wt!.path, prompt: t?.url ?? data.key, title: data.key, ticket: data.key, node: wt!.node }),
    onSuccess: (term) => {
      qc.invalidateQueries({ queryKey: ["terms"] });
      a.started(id, term.id);
    },
  });
  const resume = useMutation({ mutationFn: (session: string) => openSession({ id: session }) });
  const [settingUp, setSettingUp] = useState(false);
  // the kind of work it matches, whose team Set up opens, or another picked here
  const kits = useQuery({ queryKey: ["kits", data.key], queryFn: () => api.get<KitsRes>(`/claude/kits?ticket=${encodeURIComponent(data.key)}`), enabled: !!wt && !data.terms, staleTime: 60_000 }).data;
  const [kind, setKind] = useState("");
  const chosen = kits?.kinds.find((k) => k.id === (kind || kits.matched));
  const team = chosen?.team ?? kits?.fallback;
  const setUp = () => {
    setSettingUp(true);
    void a.setup(id, kind || undefined).finally(() => setSettingUp(false));
  };
  // made once per failed job: a new Error every render would tell the canvas again each time, and its update
  // renders this card again, round and round
  const jobFailed = job && job.code !== undefined && job.code !== 0 ? job.output.trim().split("\n").pop() || "The worktree couldn't be made" : undefined;
  const jobErr = useMemo(() => (jobFailed ? new Error(jobFailed) : undefined), [jobId, jobFailed]);
  const err = create.error ?? start.error ?? resume.error ?? jobErr;
  useEffect(() => {
    if (err) a.fail(err);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [err]);

  const epic = t && "children" in t;
  // an open PR whose checks fail, or that a reviewer sent back, shows on the card's edge from across the canvas
  const open = prs.filter((p) => p.state === "OPEN");
  const failing = open.some((p) => p.checks === "fail");
  const sentBack = open.some((p) => p.reviewDecision === "CHANGES_REQUESTED");
  const edge = selected ? "border-cobalt" : failing ? "border-red" : sentBack ? "border-amber" : "border-cobalt/40";
  const tone = failing ? "fail" : sentBack ? "warn" : open.some((p) => p.checks === "pending") ? "running" : open.length ? "pass" : undefined;
  useEffect(() => a.tone(id, tone), [id, tone, a]);
  const fit = useFit({ id, selected, fit: data.fit, max: 420, minWidth: 260, minHeight: 120 });
  return (
    <div className={`w-full flex flex-col rounded-lg border-2 bg-panel shadow-lg overflow-hidden ${edge}`} style={fit.style} data-ticket={data.key} data-ci={failing ? "fail" : open.some((p) => p.checks === "pending") ? "pending" : open.length ? "pass" : undefined}>
      {fit.resizer}
      <Ports />
      <div className="card-handle cursor-grab active:cursor-grabbing flex items-center gap-2 h-8 pl-2.5 pr-1 bg-cobalt-soft border-b border-line text-[12px] shrink-0" onDoubleClick={() => a.bringUp(id)} title="Drag to move, double-click to bring it up">
        {t?.url ? (
          <a href={t.url} target="_blank" rel="noreferrer" className="nodrag font-semibold text-cobalt hover:underline" title="Open it in the tracker">
            {data.key}
          </a>
        ) : (
          <span className="font-semibold text-cobalt">{data.key}</span>
        )}
        {t && <StatusTag status={t.status} category={t.statusCategory} />}
        {t?.type && <span className="text-faint truncate">{t.type}</span>}
        {t?.points !== undefined && <span className="text-faint tabular-nums">{t.points} pt</span>}
        <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending} className={`nodrag ml-auto size-6 grid place-items-center rounded text-faint hover:text-ink hover:bg-ground ${refresh.isPending ? "animate-spin" : ""}`} title="Fetch its details from the tracker again" aria-label="Refresh ticket">
          ↻
        </button>
        <button type="button" onClick={(e) => a.spawn(id, e.currentTarget.getBoundingClientRect())} className="nodrag size-6 grid place-items-center rounded text-faint hover:text-ink hover:bg-ground" title="A new terminal in its worktree, linked to it" aria-label="New linked terminal">
          +
        </button>
        <button type="button" onClick={() => a.removeCard(id)} className="nodrag size-6 grid place-items-center rounded text-faint hover:text-red hover:bg-ground" title="Take it off the canvas (the ticket stays as it is)" aria-label="Remove ticket card">
          ×
        </button>
      </div>
      <div className="flex-auto min-h-0 flex flex-col gap-2 p-2.5 text-[13px]">
        <div className="line-clamp-2 font-medium">{t?.summary ?? <span className="text-faint font-normal">{loading || refresh.isPending ? "Fetching its details" : "The tracker has no ticket by that key, or couldn't be reached. ↻ asks it again."}</span>}</div>
        {t && !mine && t.assignee && <div className="text-[12px] text-muted -mt-1">Assigned to {t.assignee}</div>}
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {wt ? (
            <Tag title={wt.path}>
              {wt.node && wt.node !== "local" ? `${wt.node} · ` : ""}
              {wt.branch ?? wt.name}
            </Tag>
          ) : (
            <span className="text-faint">No worktree yet</span>
          )}
          {prs.map((p) => (
            <span key={p.number} className="inline-flex items-center gap-1">
              <PrBadge pr={p} />
              <Checks pr={p} />
            </span>
          ))}
          {epic && <span className="text-faint">{(t as Epic).children.length} tickets</span>}
          {data.terms > 0 && <span className="text-faint">{data.terms === 1 ? "1 terminal" : `${data.terms} terminals`}</span>}
        </div>
        <div className="mt-auto flex flex-wrap gap-1.5 nodrag">
          {wt ? (
            <>
              {!data.terms && (
                <Button size="sm" variant="primary" disabled={settingUp} onClick={setUp} title={team ? `Its team, laid out and linked: ${team.terms.map((m) => `${m.name}${m.planFirst ? " (plans first)" : ""}`).join(", ")}` : `${agent} and its team, laid out and linked`}>
                  {settingUp ? "Setting up" : "Set up"}
                </Button>
              )}
              {!data.terms && !!kits?.kinds.length && (
                <select value={kind} onChange={(e) => setKind(e.target.value)} className="h-7 max-w-40 rounded border border-line bg-raised px-1 text-[12px] text-muted" aria-label="Kind of work" title="Whose team Set up opens">
                  <option value="">{kits.matched ? `${kits.kinds.find((k) => k.id === kits.matched)?.name} (it matches)` : "The usual pair"}</option>
                  {kits.kinds
                    .filter((k) => k.id !== kits.matched)
                    .map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}
                      </option>
                    ))}
                </select>
              )}
              <Button size="sm" variant={data.terms ? "default" : "ghost"} disabled={start.isPending} onClick={() => start.mutate()} title={`Starts ${agent} in its worktree with ${t?.url ?? data.key}`}>
                {start.isPending ? "Starting" : `Start ${agent}`}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" disabled={create.isPending || creating} onClick={() => create.mutate()} title="Makes its worktree, from the template that matches it">
              {creating ? "Making the worktree" : "Create worktree"}
            </Button>
          )}
          {t?.lastSession && (
            <Button size="sm" variant="ghost" disabled={resume.isPending} onClick={() => resume.mutate(t.lastSession!.id)} title={`Last session ${ago(t.lastSession.updatedAt)}`}>
              Resume
            </Button>
          )}
          {open.map((p) => (
            <PrFix key={p.number} pr={p} />
          ))}
        </div>
      </div>
    </div>
  );
}
