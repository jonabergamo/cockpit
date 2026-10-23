import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { BoardCard, BoardColumn, PullRequest } from "@cockpit/shared";
import { BoardCardDetail } from "../components/BoardCardDetail";
import { newTask } from "../components/NewTask";
import { Button, Drawer, Empty, ErrorNote, Loading, PageHeader, Tabs, Tag } from "../components/ui";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useLive, useLiveSessions } from "../lib/live";
import { SpendTag } from "../components/Budget";
import { statusLook } from "../lib/status";
import { TasksList } from "./Tasks";

const COLUMNS: { id: BoardColumn; title: string; hint: string }[] = [
  { id: "queued", title: "Queued", hint: "Tasks waiting for a free slot" },
  { id: "working", title: "Working", hint: "Claude or autopilot is on it" },
  { id: "needs", title: "Needs you", hint: "Can't move until you answer or decide" },
  { id: "review", title: "In review", hint: "Waiting for checks or reviewers" },
  { id: "ready", title: "Ready to merge", hint: "Approved, or merged and done" },
];

export const useBoard = () => {
  const qc = useQueryClient();
  const live = useLiveSessions();
  const q = useQuery({ queryKey: ["board"], queryFn: () => api.get<BoardCard[]>("/board"), refetchInterval: 30_000 });
  // sessions change every few seconds; one refetch per change in who's working or waiting is enough
  const sig = live.map((s) => `${s.id}:${s.status}`).join(",");
  useEffect(() => void qc.invalidateQueries({ queryKey: ["board"] }), [sig, qc]);
  useLive((ev) => ev.type === "board" && qc.invalidateQueries({ queryKey: ["board"] }), [qc]);
  return q;
};

export const asPr = (c: BoardCard): PullRequest | undefined =>
  c.pr && { number: c.pr.number, title: c.pr.title, url: c.pr.url, state: c.pr.state, checks: c.pr.checks, ignoredFailing: c.pr.ignoredFailing, reviewDecision: c.pr.review, isDraft: c.pr.isDraft, mergeable: c.pr.mergeable, branch: c.branch ?? "", createdAt: "" };

const tone = (c: BoardCard) => (c.column === "needs" ? "text-amber" : c.column === "working" ? "text-cobalt" : c.column === "ready" ? "text-green" : "text-muted");

function prLabel(c: BoardCard) {
  const p = c.pr!;
  if (p.state === "MERGED") return { tone: "green" as const, text: "merged" };
  if (p.checks === "fail") return { tone: "red" as const, text: "checks failing" };
  if (p.mergeable === "CONFLICTING") return { tone: "red" as const, text: "conflict" };
  if (p.review === "CHANGES_REQUESTED") return { tone: "amber" as const, text: "changes requested" };
  if (p.review === "APPROVED") return { tone: "green" as const, text: "approved" };
  return { tone: "plain" as const, text: p.isDraft ? "draft" : p.checks === "pending" ? "checks running" : "in review" };
}

function Card({ c, onOpen }: { c: BoardCard; onOpen: () => void }) {
  const s = c.session;
  return (
    <button onClick={onOpen} className="w-full text-left rounded-md border border-line bg-raised hover:border-faint px-3 py-2 space-y-1.5">
      <div className="flex items-start gap-2">
        <span className="flex-1 min-w-0 text-[13px] font-medium leading-snug line-clamp-2">{c.title}</span>
        {s && s.status !== "ended" && <span className={`mt-1 size-2 rounded-full shrink-0 ${statusLook(s.status, s.waitingFor, s.background).dot} ${s.status === "busy" ? "animate-pulse" : ""}`} title={statusLook(s.status, s.waitingFor, s.background).hint} />}
      </div>
      <div className="flex items-center gap-1.5 text-[12px] text-muted min-w-0">
        {c.ticket && <span className="shrink-0 rounded bg-ground px-1 font-mono text-[11px] text-ink">{c.ticket}</span>}
        <span className="truncate">{c.folder}</span>
      </div>
      <div className={`text-[12px] ${tone(c)} truncate`}>{c.stuck ? `Stuck: ${c.stuck}` : c.reason}</div>
      <div className="flex flex-wrap items-center gap-1">
        {c.pr && (
          <Tag tone={prLabel(c).tone}>
            #{c.pr.number} {prLabel(c).text}
          </Tag>
        )}
        {c.verify && <Tag tone={c.verify.state === "pass" ? "green" : c.verify.state === "fail" ? "red" : "cobalt"}>{c.verify.state === "running" ? "checking" : c.verify.state === "pass" ? "checks pass" : "checks fail"}</Tag>}
        {c.autopilot?.on && <Tag tone={c.autopilot.gaveUp ? "amber" : "cobalt"}>{c.autopilot.gaveUp ? "autopilot gave up" : `autopilot${c.autopilot.attempts ? ` ${c.autopilot.attempts}×` : ""}`}</Tag>}
        {c.task && c.task.attempt > 1 && <Tag>attempt {c.task.attempt}</Tag>}
        <SpendTag spend={c.spend} />
        <span className="ml-auto text-[11px] text-faint">{ago(c.updatedAt)}</span>
      </div>
    </button>
  );
}

export function BoardPage() {
  const { card: openId, filter } = useSearch({ from: "/board" });
  const navigate = useNavigate();
  const q = useBoard();
  const [quiet, setQuiet] = useState(false);
  const cards = q.data ?? [];
  const open = cards.find((c) => c.id === openId);
  const setOpen = (id?: string) => navigate({ to: "/board", search: { card: id, filter }, replace: true });
  const columns = quiet ? [...COLUMNS, { id: "quiet" as const, title: "Quiet", hint: "Worktrees with nothing going on lately" }] : COLUMNS;
  const quietCount = cards.filter((c) => c.column === "quiet").length;
  const qc = useQueryClient();
  const lead = useMutation({
    mutationFn: () => api.post<{ id: string }>("/claude/lead"),
    onSuccess: async (t) => {
      await qc.invalidateQueries({ queryKey: ["terms"] });
      navigate({ to: "/terminals", search: { id: t.id } });
    },
  });

  return (
    <div className="space-y-4 h-full flex flex-col">
      <PageHeader title="Work" sub={filter === "tasks" ? "Tasks cockpit runs in its own worktrees. Tasks that wait on others line up in waves." : "Everything in flight, by what it needs next."}>
        <Tabs<"board" | "tasks">
          value={filter ?? "board"}
          onChange={(v) => navigate({ to: "/board", search: { card: openId, filter: v === "tasks" ? "tasks" : undefined } })}
          items={[
            { value: "board", label: "Board" },
            { value: "tasks", label: "Queued and attempts" },
          ]}
        />
        {filter !== "tasks" && quietCount > 0 && (
          <Button variant="ghost" onClick={() => setQuiet((v) => !v)}>
            {quiet ? "Hide quiet" : `Show quiet (${quietCount})`}
          </Button>
        )}
        <Button onClick={() => lead.mutate()} disabled={lead.isPending} title="A Claude session that plans with you and runs the work through these workers (needs Cockpit tools for Claude, in Settings → Setup)">
          {lead.isPending ? "Opening" : "Lead"}
        </Button>
        <Button variant="primary" onClick={() => newTask.open()}>
          New task
        </Button>
      </PageHeader>
      <ErrorNote error={filter === "tasks" ? lead.error : (q.error ?? lead.error)} />
      {filter === "tasks" ? (
        <TasksList />
      ) : q.isLoading ? (
        <Loading what="Gathering sessions, worktrees and PRs" />
      ) : !cards.length ? (
        <Empty>Nothing in flight. Start Claude in a worktree, or queue a task.</Empty>
      ) : (
        <div className="flex-1 min-h-0 flex gap-3 overflow-x-auto pb-2 max-md:flex-col max-md:overflow-x-visible">
          {columns.map((col) => {
            const list = cards.filter((c) => c.column === col.id);
            return (
              <section key={col.id} className="flex-1 min-w-[210px] max-md:w-full flex flex-col min-h-0 bg-panel border border-line rounded-lg">
                <header className="px-3 pt-2.5 pb-2 border-b border-line" title={col.hint}>
                  <div className="flex items-center gap-2">
                    <h2 className={`font-semibold text-[13px] ${col.id === "needs" && list.length ? "text-amber" : ""}`}>{col.title}</h2>
                    <span className="text-[12px] text-faint">{list.length}</span>
                  </div>
                </header>
                <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
                  {list.map((c) => (
                    <Card key={c.id} c={c} onOpen={() => setOpen(c.id)} />
                  ))}
                  {!list.length && <div className="text-[12px] text-faint px-1 py-2">{col.hint}.</div>}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <Drawer open={!!open} onClose={() => setOpen(undefined)} width="min(640px, 100vw)">
        {open && <BoardCardDetail c={open} onClose={() => setOpen(undefined)} />}
      </Drawer>
    </div>
  );
}
