import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Worktree } from "@cockpit/shared";
import { JobLog } from "../components/JobLog";
import { RefreshButton } from "../components/RefreshButton";
import { Button, ErrorNote, inputClass, Loading, Modal, PageHeader, StatusTag, Tag } from "../components/ui";
import { api } from "../lib/api";
import { ago, bytes } from "../lib/format";
import { useAppConfig, useJobs, usePrs, useWorktrees } from "../lib/queries";
import { useEditorName } from "../components/OpenEditor";
import { LaunchModal } from "./Sessions";
import { PrBadge, useTickets } from "./Tickets";

export function WorktreesPage() {
  const wts = useWorktrees();
  const tickets = useTickets();
  const prs = usePrs();
  const jobs = useJobs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const editorName = useEditorName();
  // the statuses Settings counts as released
  const released = new Set((useAppConfig().data?.releasedStatuses ?? []).map((s) => s.toLowerCase()));
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<Worktree>();
  const [launch, setLaunch] = useState<string>();
  const [filter, setFilter] = useState("");
  const [cleaning, setCleaning] = useState(false);

  const byKey = new Map(tickets.data?.tickets.map((t) => [t.key, t]));
  const prFor = (w: Worktree) => prs.data?.mine.find((p) => p.branch === w.branch) ?? prs.data?.mine.find((p) => w.ticket && p.ticket === w.ticket);

  const refresh = () => Promise.all(["worktrees", "roots"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const run = useMutation({
    mutationFn: ({ url, path }: { url: string; path: string }) => api.post<{ id: string }>(url, { path }),
    onSuccess: (j) => setJobIds((ids) => [j.id, ...ids]),
  });

  // a worktree can go once its PR is merged or its ticket is released, and nothing is left uncommitted
  const removable = (w: Worktree) => {
    if (w.main || w.dirty) return false;
    const pr = prFor(w);
    const t = w.ticket ? byKey.get(w.ticket) : undefined;
    return pr?.state === "MERGED" || pr?.state === "CLOSED" || (!!t && released.has(t.status.toLowerCase()));
  };

  const list = (wts.data ?? []).filter((w) => !filter || `${w.name} ${w.branch} ${w.ticket}`.toLowerCase().includes(filter.toLowerCase()));
  const total = list.reduce((n, w) => n + (w.sizeBytes ?? 0), 0);
  const freeable = list.filter(removable).reduce((n, w) => n + (w.sizeBytes ?? 0), 0);
  const active = jobs.data?.filter((j) => jobIds.includes(j.id)) ?? [];

  return (
    <div className="max-w-[1300px]">
      <PageHeader
        title="Worktrees"
        sub={wts.data ? `${list.length} worktrees${total ? `, ${bytes(total)} on disk` : ""}${freeable ? `, ${bytes(freeable)} can go` : ""}` : undefined}
      >
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className={inputClass} />
        <Button onClick={refresh}>Refresh</Button>
        <Button variant="primary" onClick={() => setCleaning(true)}>
          Clean up
        </Button>
      </PageHeader>

      {active.length > 0 && (
        <div className="space-y-2 mb-4">
          {active.map((j) => (
            <JobLog key={j.id} job={j} onDone={refresh} />
          ))}
        </div>
      )}
      <ErrorNote error={run.error} />
      {wts.isLoading && <Loading what="Reading git worktrees" />}

      <div className="bg-panel border border-line rounded-lg divide-y divide-line">
        {list.map((w) => {
          const t = w.ticket ? byKey.get(w.ticket) : undefined;
          const pr = prFor(w);
          return (
            <div key={w.path} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
              <div className="flex-1 min-w-[260px]">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{w.name}</span>
                  {w.main && <Tag>main checkout</Tag>}
                  {removable(w) && <Tag tone="green">safe to remove</Tag>}
                </div>
                <div className="text-[12px] text-muted truncate">
                  <span className="font-mono">{w.branch ?? `detached ${w.head}`}</span>
                  {w.lastCommitAt ? ` · last commit ${ago(w.lastCommitAt)}` : ""}
                </div>
                {t && (
                  <Link to="/tickets" search={{ key: t.key }} className="text-[12px] hover:text-cobalt flex items-center gap-1.5 mt-0.5">
                    <span className="truncate max-w-[340px]">
                      {t.key} {t.summary}
                    </span>
                    <StatusTag status={t.status} category={t.statusCategory} />
                  </Link>
                )}
              </div>
              <div className="flex items-center gap-2 text-[12px] text-muted">
                {pr && <PrBadge pr={pr} />}
                {!!w.dirty && <Tag tone="amber">{w.dirty} changed</Tag>}
                {!!w.ahead && <Tag tone="cobalt">{w.ahead} ahead</Tag>}
                {!!w.behind && <Tag tone="faint">{w.behind} behind</Tag>}
                <span className="w-16 text-right">{bytes(w.sizeBytes)}</span>
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="primary" onClick={() => run.mutate({ url: "/worktrees/open", path: w.path })}>
                  {editorName}
                </Button>
                <Button size="sm" onClick={() => navigate({ to: "/code", search: { root: w.path } })}>
                  Code
                </Button>
                <Button size="sm" onClick={() => setLaunch(w.path)}>
                  Claude
                </Button>
                {!w.main && (
                  <Button size="sm" variant="danger" onClick={() => setConfirm(w)}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {wts.data && !list.length && <div className="px-3 py-6 text-center text-muted">{filter ? `No worktree matches "${filter}".` : "No worktrees yet."}</div>}
      </div>

      <Modal open={!!confirm} onClose={() => setConfirm(undefined)} title={`Remove ${confirm?.name}?`}>
        <p className="text-[14px] mb-3">
          This deletes the folder{confirm?.sizeBytes ? ` and frees ${bytes(confirm.sizeBytes)}` : ""}. The branch stays in git.
          {confirm?.dirty ? <span className="text-red"> It has {confirm.dirty} uncommitted changes that will be lost.</span> : null}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(undefined)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              run.mutate({ url: "/worktrees/delete", path: confirm!.path });
              setConfirm(undefined);
            }}
          >
            Remove worktree
          </Button>
        </div>
      </Modal>
      {launch && <LaunchModal open onClose={() => setLaunch(undefined)} cwd={launch} />}
      {cleaning && <Cleaner onClose={() => setCleaning(false)} />}
    </div>
  );
}

interface Candidate {
  path: string;
  name: string;
  branch?: string;
  ticket?: string;
  ticketStatus?: string;
  pr?: { number: number; state: string; url: string };
  sizeBytes?: number;
  lastCommitAt?: number;
  reasons: string[];
  blockers: string[];
  verdict: "safe" | "check" | "keep";
}

// Lists every worktree that looks done with, ticks the ones with nothing to lose, and removes the ticked ones
// in one job. Anything with uncommitted or unpushed work, or something running in it, needs ticking by hand.
function Cleaner({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const jobs = useJobs();
  const plan = useQuery({ queryKey: ["worktree-clean"], queryFn: () => api.get<Candidate[]>("/worktrees/clean") });
  const [picked, setPicked] = useState<Set<string>>();
  const [sure, setSure] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const job = jobs.data?.find((j) => j.id === jobId);

  const list = plan.data ?? [];
  const chosen = picked ?? new Set(list.filter((c) => c.verdict === "safe").map((c) => c.path));
  const sel = list.filter((c) => chosen.has(c.path));
  const size = sel.reduce((n, c) => n + (c.sizeBytes ?? 0), 0);
  const risky = sel.filter((c) => c.blockers.length);

  const toggle = (path: string) => {
    const next = new Set(chosen);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setPicked(next);
    setSure(false);
  };

  const remove = useMutation({
    mutationFn: () => api.post<{ id: string }>("/worktrees/clean", { paths: sel.map((c) => c.path) }),
    onSuccess: (j) => setJobId(j.id),
  });

  const row = (c: Candidate) => (
    <label key={c.path} className="flex items-start gap-2.5 px-3 py-2 hover:bg-ground cursor-pointer">
      <input type="checkbox" className="mt-1" checked={chosen.has(c.path)} onChange={() => toggle(c.path)} disabled={!!jobId} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-[13px]">{c.name}</span>
          {c.branch && <span className="font-mono text-[11px] text-muted truncate">{c.branch}</span>}
          <span className="ml-auto text-[12px] text-muted shrink-0">{bytes(c.sizeBytes)}</span>
        </div>
        <div className="flex flex-wrap gap-1 mt-0.5">
          {c.reasons.map((r) => (
            <Tag key={r} tone="green">
              {r}
            </Tag>
          ))}
          {c.blockers.map((r) => (
            <Tag key={r} tone="amber">
              {r}
            </Tag>
          ))}
        </div>
      </div>
    </label>
  );

  const safe = list.filter((c) => c.verdict === "safe");
  const check = list.filter((c) => c.verdict === "check");
  const keep = list.filter((c) => c.verdict === "keep");

  return (
    <Modal open onClose={onClose} title="Clean up worktrees" wide>
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <span className="flex-1">A worktree can go once its PR is merged or closed, its ticket is released, or it has sat idle for a month. The branch stays in git.</span>
          <RefreshButton targets={[{ key: ["worktree-clean"], url: "/worktrees/clean" }]} />
        </div>
        {plan.isLoading && <Loading what="Checking every worktree" />}
        <ErrorNote error={plan.error} />
        {plan.data && (
          <div className="max-h-[52vh] overflow-y-auto border border-line rounded-md divide-y divide-line">
            <div className="px-3 py-1.5 text-[12px] text-faint bg-panel sticky top-0">Nothing to lose · {safe.length}</div>
            {safe.map(row)}
            {!safe.length && <div className="px-3 py-2 text-[13px] text-muted">Nothing is clearly finished.</div>}
            {check.length > 0 && <div className="px-3 py-1.5 text-[12px] text-faint bg-panel sticky top-0">Look first · {check.length}</div>}
            {check.map(row)}
            {keep.length > 0 && (
              <div className="px-3 py-2 text-[12px] text-faint">
                Keeping {keep.length} still in use: {keep.map((c) => c.name).join(", ")}
              </div>
            )}
          </div>
        )}
        {job && <JobLog job={job} onDone={() => Promise.all(["worktrees", "roots", "worktree-clean"].map((k) => qc.invalidateQueries({ queryKey: [k] })))} />}
        <ErrorNote error={remove.error} />
        {sure && risky.length > 0 && !jobId && (
          <p className="text-[13px] text-red">
            {risky.map((c) => c.name).join(", ")} still {risky.length === 1 ? "has" : "have"} work that only lives there ({[...new Set(risky.flatMap((c) => c.blockers))].join(", ")}). It will be lost.
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <span className="text-[13px] text-muted mr-auto">{sel.length ? `${sel.length} picked, frees ${bytes(size) || "some space"}` : "Nothing picked"}</span>
          <Button variant="ghost" onClick={onClose}>
            {job?.code !== undefined ? "Done" : "Cancel"}
          </Button>
          {!jobId && (
            <Button variant="danger" disabled={!sel.length || remove.isPending} onClick={() => (sure ? remove.mutate() : setSure(true))}>
              {sure ? `Yes, remove ${sel.length}` : `Remove ${sel.length}`}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
