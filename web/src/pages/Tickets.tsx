import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Epic, PullRequest, Ticket, Worktree } from "@cockpit/shared";
import { JobLog } from "../components/JobLog";
import { PrFix } from "../components/PrFix";
import { newTask } from "../components/NewTask";
import { RefreshButton } from "../components/RefreshButton";
import { Button, ErrorNote, inputClass, Loading, Modal, PageHeader, StatusTag, Tag } from "../components/ui";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useOpenSession } from "../lib/openSession";
import { useAppConfig, useJobs, usePrs, useTickets, useWorktrees } from "../lib/queries";

export { useTickets };

export function PrBadge({ pr }: { pr: PullRequest }) {
  const tone = pr.state === "MERGED" ? "green" : pr.state === "CLOSED" ? "faint" : pr.checks === "fail" ? "red" : pr.reviewDecision === "APPROVED" ? "green" : "amber";
  const label = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : pr.checks === "fail" ? "checks failing" : pr.reviewDecision === "APPROVED" ? "approved" : "in review";
  return (
    <a href={pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="hover:underline">
      <Tag tone={tone} title={pr.ignoredFailing ? `${pr.title}\nFailing but ignored in Settings: ${pr.ignoredFailing.join(", ")}` : pr.title}>
        #{pr.number} {label}
        {pr.ignoredFailing && pr.state === "OPEN" && <span className="opacity-60"> · {pr.ignoredFailing.length} ignored</span>}
      </Tag>
    </a>
  );
}

export function TicketsPage() {
  const { key } = useSearch({ from: "/tickets" });
  const tickets = useTickets();
  const prs = usePrs();
  const wts = useWorktrees();
  const cfg = useAppConfig();
  const [filter, setFilter] = useState("");
  const [addingEpic, setAddingEpic] = useState(false);

  const prsBy = new Map<string, PullRequest[]>();
  for (const p of prs.data?.mine ?? []) if (p.ticket && p.state !== "CLOSED") prsBy.set(p.ticket, [...(prsBy.get(p.ticket) ?? []), p]);
  const wtBy = new Map<string, Worktree>();
  for (const w of wts.data ?? []) if (w.ticket && !w.main) wtBy.set(w.ticket, w);

  const q = filter.trim().toLowerCase();
  const shown = (tickets.data?.tickets ?? []).filter((t) => !q || `${t.key} ${t.summary} ${t.status}`.toLowerCase().includes(q));
  const order = cfg.data?.statusOrder ?? [];
  const rank = (s: string) => (order.includes(s) ? order.indexOf(s) : order.length);
  // tickets stacked on an epic live under that epic, not in the plain lists
  const epics = tickets.data?.epics ?? [];
  const epicKeys = new Set(epics.map((e) => e.key));
  const plain = shown.filter((t) => !t.epic && !epicKeys.has(t.key));
  const sprint = plain.filter((t) => t.inSprint).sort((a, b) => rank(a.status) - rank(b.status));
  const other = plain.filter((t) => !t.inSprint);

  const group = (title: string, list: Ticket[]) => (
    <section className="bg-panel border border-line rounded-lg">
      <h2 className="font-semibold px-4 pt-3 pb-2">
        {title} <span className="text-muted font-normal text-[13px]">{list.length}</span>
      </h2>
      <div className="divide-y divide-line">
        {list.map((t) => (
          <Row key={t.key} t={t} prs={prsBy.get(t.key) ?? []} wt={wtBy.get(t.key)} highlight={t.key === key} />
        ))}
        {!list.length && <div className="px-4 py-3 text-[13px] text-muted">Nothing here.</div>}
      </div>
    </section>
  );

  return (
    <div className="max-w-[1100px] space-y-4">
      <PageHeader title="Tickets" sub={tickets.data?.sprint?.name}>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className={`${inputClass} w-48`} />
        <Button onClick={() => setAddingEpic(true)}>Epic worktree</Button>
        <RefreshButton
          targets={[
            { key: ["tickets"], url: "/tickets" },
            { key: ["prs"], url: "/prs" },
            { key: ["worktrees"] },
          ]}
        />
      </PageHeader>
      {tickets.isLoading && <Loading what="Asking Jira" />}
      <ErrorNote error={tickets.error} />
      {tickets.data && (
        <>
          {epics
            // an epic with nothing of mine left open is just an old worktree
            .filter((e) => shown.some((t) => t.epic === e.key))
            .map((e) => (
              <EpicGroup key={e.key} epic={e} wt={wtBy.get(e.key)} tickets={shown.filter((t) => t.epic === e.key)} prsBy={prsBy} highlight={key} />
            ))}
          {group("This sprint", sprint)}
          {group("Other open tickets", other)}
        </>
      )}
      {addingEpic && <NewEpic onClose={() => setAddingEpic(false)} />}
    </div>
  );
}

// One worktree and one Claude session per epic; each ticket is sent into that session so the PRs stack.
function EpicGroup({ epic: e, wt, tickets, prsBy, highlight }: { epic: Epic; wt?: Worktree; tickets: Ticket[]; prsBy: Map<string, PullRequest[]>; highlight?: string }) {
  const navigate = useNavigate();
  const openSession = useOpenSession();
  const editor = useMutation({ mutationFn: (path: string) => api.post("/worktrees/open", { path }) });
  const start = useMutation({
    mutationFn: (prompt: string) => api.post<{ id: string }>("/claude/launch", { cwd: wt!.path, prompt, title: e.key }),
    onSuccess: (term) => navigate({ to: "/terminals", search: { id: term.id } }),
  });
  const resume = useMutation({ mutationFn: (prompt?: string) => openSession({ id: e.lastSession!.id }, prompt) });
  // into the epic's session when there is one, otherwise that ticket starts it
  const work = (t: Ticket) => (e.lastSession ? resume.mutate(t.url ?? t.key) : start.mutate(t.url ?? t.key));
  const busy = start.isPending || resume.isPending;

  return (
    <section className="bg-panel border border-line rounded-lg">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pt-3 pb-2.5 border-b border-line">
        <div className="flex-1 min-w-[280px]">
          <div className="flex items-center gap-2">
            <Tag tone="cobalt">epic</Tag>
            <a href={e.url} target="_blank" rel="noreferrer" className="font-semibold hover:text-cobalt">
              {e.key}
            </a>
            <span className="text-[12px] text-muted">{tickets.length} of mine open</span>
          </div>
          <div className="text-[13px] text-muted truncate">{e.summary}</div>
        </div>
        {wt && (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => editor.mutate(wt.path)}>
              VS Code
            </Button>
            <Button size="sm" onClick={() => navigate({ to: "/code", search: { root: wt.path } })}>
              Code
            </Button>
            {e.lastSession ? (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => resume.mutate(undefined)} title={`Last active ${ago(e.lastSession.updatedAt)}`}>
                {resume.isPending ? "Opening" : "Resume epic session"}
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => start.mutate(e.url ?? e.key)} title={`Starts Claude with ${e.url ?? e.key}`}>
                {start.isPending ? "Starting" : "Start epic session"}
              </Button>
            )}
          </div>
        )}
      </div>
      <ErrorNote error={editor.error ?? start.error ?? resume.error} />
      <div className="divide-y divide-line">
        {tickets.map((t) => (
          <div key={t.key} className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-8 pr-4 py-2 ${t.key === highlight ? "bg-cobalt-soft/50" : ""}`}>
            <div className="flex-1 min-w-[260px]">
              <div className="flex items-center gap-2">
                <a href={t.url} target="_blank" rel="noreferrer" className="font-medium hover:text-cobalt">
                  {t.key}
                </a>
                <StatusTag status={t.status} category={t.statusCategory} />
                {t.inSprint && <Tag>sprint</Tag>}
                {(prsBy.get(t.key) ?? []).map((p) => (
                  <PrBadge key={p.number} pr={p} />
                ))}
                {(prsBy.get(t.key) ?? []).map((p) => (
                  <PrFix key={`fix${p.number}`} pr={p} />
                ))}
              </div>
              <div className="text-[13px] text-muted truncate">{t.summary}</div>
            </div>
            {wt && (
              <Button size="sm" disabled={busy} onClick={() => work(t)} title={e.lastSession ? `Types ${t.url ?? t.key} into the epic's Claude session` : `Starts the epic's Claude session with ${t.url ?? t.key}`}>
                {e.lastSession ? "Send to epic session" : "Start with this one"}
              </Button>
            )}
          </div>
        ))}
        {!tickets.length && <div className="pl-8 pr-4 py-2.5 text-[13px] text-muted">No open tickets of yours in this epic.</div>}
      </div>
    </section>
  );
}

function NewEpic({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const jobs = useJobs();
  const [input, setInput] = useState("");
  const [jobId, setJobId] = useState<string>();
  const job = jobs.data?.find((j) => j.id === jobId);
  const [existing, setExisting] = useState<string>();
  const create = useMutation({
    mutationFn: () => api.post<{ id?: string; existing?: string }>("/epics", { input }),
    onSuccess: (r) => {
      if (r.id) return setJobId(r.id);
      setExisting(r.existing);
      Promise.all(["worktrees", "roots", "tickets"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    },
  });

  return (
    <Modal open onClose={onClose} title="Epic worktree">
      <form
        className="space-y-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          create.mutate();
        }}
      >
        <p className="text-[13px] text-muted">One worktree for the whole epic. Its tickets get worked in the epic's Claude session, so their PRs stack on the epic branch.</p>
        <input autoFocus value={input} onChange={(ev) => setInput(ev.target.value)} placeholder="Epic key or Jira link" className={`${inputClass} w-full`} />
        <ErrorNote error={create.error} />
        {existing && <p className="text-[13px] text-green">It already had a worktree at {existing}, so that one is used for the epic now.</p>}
        {job && (
          <JobLog
            job={job}
            onDone={() => {
              // the new worktree changes which epics exist, and the server picks that up on its own
              Promise.all(["worktrees", "roots", "tickets"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
            }}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {job?.code === 0 || existing ? "Done" : "Cancel"}
          </Button>
          <Button variant="primary" disabled={!input.trim() || create.isPending || (!!job && job.code === undefined)}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Row({ t, prs, wt, highlight }: { t: Ticket; prs: PullRequest[]; wt?: Worktree; highlight: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const openSession = useOpenSession();
  const jobs = useJobs();
  const ref = useRef<HTMLDivElement>(null);
  const [jobId, setJobId] = useState<string>();
  const job = jobs.data?.find((j) => j.id === jobId);

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: "center" });
  }, [highlight]);

  const create = useMutation({ mutationFn: () => api.post<{ id: string }>("/worktrees", { key: t.key, summary: t.summary }), onSuccess: (j) => setJobId(j.id) });
  const editor = useMutation({ mutationFn: (path: string) => api.post("/worktrees/open", { path }) });
  // the ticket link alone is enough for a ticket-to-PR skill to pick it up
  const start = useMutation({
    mutationFn: (cwd: string) => api.post<{ id: string }>("/claude/launch", { cwd, prompt: t.url ?? t.key, title: t.key }),
    onSuccess: (term) => navigate({ to: "/terminals", search: { id: term.id } }),
  });
  const resume = useMutation({ mutationFn: (id: string) => openSession({ id }) });
  const running = !!job && job.code === undefined;

  return (
    <div ref={ref} className={`px-4 py-2.5 ${highlight ? "bg-cobalt-soft/50" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex-1 min-w-[280px]">
          <div className="flex items-center gap-2">
            {t.url ? (
              <a href={t.url} target="_blank" rel="noreferrer" className="font-medium hover:text-cobalt">
                {t.key}
              </a>
            ) : (
              <span className="font-medium">{t.key}</span>
            )}
            <StatusTag status={t.status} category={t.statusCategory} />
            {prs.map((p) => (
              <PrBadge key={p.number} pr={p} />
            ))}
            {prs.map((p) => (
              <PrFix key={`fix${p.number}`} pr={p} />
            ))}
          </div>
          <div className="text-[13px] text-muted truncate">{t.summary}</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {wt ? (
            <>
              <Button size="sm" onClick={() => editor.mutate(wt.path)}>
                VS Code
              </Button>
              <Button size="sm" onClick={() => navigate({ to: "/code", search: { root: wt.path } })}>
                Code
              </Button>
              <Button size="sm" variant={t.lastSession ? "default" : "primary"} disabled={start.isPending} onClick={() => start.mutate(wt.path)} title={`Starts Claude with ${t.url ?? t.key}`}>
                {start.isPending ? "Starting" : "Start Claude"}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" disabled={create.isPending || running} onClick={() => create.mutate()}>
              {running ? "Creating" : "Create worktree"}
            </Button>
          )}
          {t.lastSession && (
            <Button size="sm" variant="primary" disabled={resume.isPending} onClick={() => resume.mutate(t.lastSession!.id)} title={`Last session ${ago(t.lastSession.updatedAt)}`}>
              {resume.isPending ? "Opening" : "Resume Claude"}
            </Button>
          )}
          {!wt && (
            <Button size="sm" variant="ghost" onClick={() => newTask.open({ ticket: t.key })} title="Queue it: cockpit makes the worktree and starts Claude on it, optionally a few attempts at once">
              Task
            </Button>
          )}
        </div>
      </div>
      <ErrorNote error={create.error ?? editor.error ?? start.error ?? resume.error} />
      {job && (
        <div className="mt-2">
          <JobLog
            job={job}
            onDone={() => {
              qc.invalidateQueries({ queryKey: ["worktrees"] });
              qc.invalidateQueries({ queryKey: ["roots"] });
            }}
          />
        </div>
      )}
    </div>
  );
}
