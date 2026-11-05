import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Epic, PullRequest, Ticket } from "@cockpit/shared";
import { useAgentName } from "../../lib/agent";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { useOpenSession } from "../../lib/openSession";
import { useJobs, usePrs, useTickets, useWorktrees } from "../../lib/queries";
import { PrBadge } from "../../pages/Tickets";
import { PrFix } from "../PrFix";
import { Button, StatusTag, Tag } from "../ui";
import { useActions } from "./context";
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

export type TicketData = { key: string; terms: number };
export type TicketCardNode = Node<TicketData, "ticket">;

const useTicket = (key: string): Ticket | Epic | undefined => {
  const t = useTickets().data;
  return [...(t?.tickets ?? []), ...(t?.epics ?? [])].find((x) => x.key === key);
};

// A ticket on the canvas: where it stands in the tracker, its worktree and PRs, and the way to start on it. The
// terminals working on it hang off it by a line.
export function TicketCard({ id, data, selected }: NodeProps<TicketCardNode>) {
  const a = useActions();
  const agent = useAgentName();
  const qc = useQueryClient();
  const openSession = useOpenSession();
  const t = useTicket(data.key);
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
  const err = create.error ?? start.error ?? resume.error ?? (job && job.code !== undefined && job.code !== 0 ? new Error(job.output.trim().split("\n").pop() || "The worktree couldn't be made") : undefined);
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
  return (
    <div className={`h-full w-full flex flex-col rounded-lg border-2 bg-panel shadow-lg overflow-hidden ${edge}`} data-ticket={data.key} data-ci={failing ? "fail" : open.some((p) => p.checks === "pending") ? "pending" : open.length ? "pass" : undefined}>
      <NodeResizer isVisible={selected} minWidth={260} minHeight={150} color="var(--cobalt)" />
      <Ports />
      <div className="card-handle cursor-grab active:cursor-grabbing flex items-center gap-2 h-8 pl-2.5 pr-1 bg-cobalt-soft border-b border-line text-[12px] shrink-0" onDoubleClick={() => a.bringUp(id)} title="Drag to move, double-click to see it at 100%">
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
        <button type="button" onClick={() => a.removeCard(id)} className="nodrag ml-auto size-6 grid place-items-center rounded text-faint hover:text-red hover:bg-ground" title="Take it off the canvas (the ticket stays as it is)" aria-label="Remove ticket card">
          ×
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col gap-2 p-2.5 text-[13px]">
        <div className="line-clamp-2 font-medium">{t?.summary ?? <span className="text-faint font-normal">Not one of your open tickets, so cockpit has no details for it.</span>}</div>
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
            <Button size="sm" variant={data.terms ? "default" : "primary"} disabled={start.isPending} onClick={() => start.mutate()} title={`Starts ${agent} in its worktree with ${t?.url ?? data.key}`}>
              {start.isPending ? "Starting" : `Start ${agent}`}
            </Button>
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
