import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import type { Flow, FlowRun, FlowRunStatus, FlowRunStep, FlowStep, FlowStepStatus } from "@cockpit/shared";
import { Button, Empty, ErrorNote, inputClass, Loading, Markdown, Modal, PageHeader, Panel, Tag } from "../components/ui";
import { api } from "../lib/api";
import { useSaveSettings, useSettings } from "../lib/cost";
import { ago, shortPath } from "../lib/format";
import { useLive } from "../lib/live";
import { useAgents } from "../lib/queries";

type Tone = "plain" | "cobalt" | "green" | "red" | "amber" | "faint";
const runTone: Record<FlowRunStatus, Tone> = { starting: "cobalt", running: "cobalt", waiting: "amber", done: "green", failed: "red", cancelled: "faint" };
const stepTone: Record<FlowStepStatus, Tone> = { pending: "faint", running: "cobalt", waiting: "amber", done: "green", failed: "red", skipped: "faint" };

type FlowInfo = Flow & { problem?: string };

const useFlows = () => useQuery({ queryKey: ["flows"], queryFn: () => api.get<FlowInfo[]>("/flows") });
const useRuns = () => {
  const qc = useQueryClient();
  useLive((ev) => ev.type === "board" && qc.invalidateQueries({ queryKey: ["flow-runs"] }), [qc]);
  return useQuery({ queryKey: ["flow-runs"], queryFn: () => api.get<FlowRun[]>("/flows/runs"), refetchInterval: 10_000 });
};

// who does a step, as a short label
function doer(s: FlowStep, names: Map<string, string>) {
  if (s.kind === "verify") return "the repo's checks";
  if (s.kind === "human") return "you";
  const who = s.agent ? (names.get(s.agent) ?? s.agent) : "default agent";
  return s.model ? `${who} · ${s.model}` : who;
}

function Recipe({ f, names, onEdit, onRun }: { f: FlowInfo; names: Map<string, string>; onEdit: () => void; onRun: () => void }) {
  return (
    <div className="rounded-md border border-line bg-raised p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-medium">{f.name}</div>
          {f.description && <div className="text-[13px] text-muted">{f.description}</div>}
        </div>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="primary" onClick={onRun} disabled={!!f.problem}>
          Run
        </Button>
      </div>
      <ol className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {f.steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-faint">→</span>}
            <span className="rounded bg-ground px-1.5 py-0.5">
              {s.name ?? s.id} <span className="text-muted">· {doer(s, names)}</span>
              {s.when && <span className="text-faint"> · if {s.when}</span>}
              {s.loop && <span className="text-amber"> · ↺ {s.loop.to} ×{s.loop.max}</span>}
            </span>
          </li>
        ))}
      </ol>
      {f.problem && <div className="text-[12px] text-red">{f.problem}</div>}
    </div>
  );
}

// a flow as JSON, checked as it's typed; the server checks it again when it runs
function EditFlow({ flow, onClose }: { flow?: Flow; onClose: () => void }) {
  const settings = useSettings();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const blank: Flow = { id: `flow-${Math.random().toString(36).slice(2, 6)}`, name: "New flow", steps: [{ id: "build", name: "Build", prompt: "{{prompt}}" }] };
  const [text, setText] = useState(() => JSON.stringify(flow ?? blank, null, 2));
  const [err, setErr] = useState<unknown>();
  let parsed: Flow | undefined;
  let bad: string | undefined;
  try {
    parsed = JSON.parse(text);
    if (!parsed?.id || !parsed.name || !Array.isArray(parsed.steps)) bad = "It needs an id, a name and steps";
  } catch (e) {
    bad = (e as Error).message;
  }
  const all = settings.data?.settings.flows ?? [];
  const put = async (list: Flow[]) => {
    try {
      await save({ flows: list });
      await qc.invalidateQueries({ queryKey: ["flows"] });
      onClose();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal open onClose={onClose} title={flow ? `Edit ${flow.name}` : "New flow"} wide>
      <div className="space-y-3 text-[13px]">
        <p className="text-muted">
          Steps run in order, each after the one before it unless <code>after</code> says otherwise. A step is an agent's turn (<code>agent</code>, <code>model</code>, <code>access</code>: sandbox, readonly or full), <code>"kind": "verify"</code> for the repo's checks, <code>"human"</code> to wait for you, or <code>"tasks"</code> to queue the tasks an agent lists. Prompts can use {"{{prompt}}"}, {"{{title}}"}, {"{{ticket}}"}, {"{{diff}}"} and {"{{steps.<id>.output}}"}. With <code>"output": "verdict"</code> a step ends in approve or changes, which <code>when</code> and <code>loop</code> read; <code>again</code> is the prompt a step gets when a loop sends the work back to it.
        </p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={22} spellCheck={false} className={`${inputClass} w-full h-auto py-2 font-mono text-[12px]`} />
        {bad && <div className="text-red text-[12px]">{bad}</div>}
        <ErrorNote error={err} />
        <div className="flex gap-2">
          {flow && (
            <Button variant="danger" onClick={() => confirm(`Delete ${flow.name}?`) && put(all.filter((f) => f.id !== flow.id))}>
              Delete
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!!bad} onClick={() => parsed && put(flow ? all.map((f) => (f.id === flow.id ? parsed! : f)) : [...all, parsed])}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function StartRun({ flow, onClose }: { flow: Flow; onClose: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ticket, setTicket] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<FlowRun>("/flows/runs", { flow: flow.id, title, prompt, ticket: ticket.trim() || undefined, from: from.trim() || undefined });
      navigate({ to: "/flows/$id", params: { id: r.id } });
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Run ${flow.name}`} wide>
      <form
        className="space-y-3 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <p className="text-muted">Cockpit makes a worktree for it and runs the steps there, one agent after another.</p>
        <label className="block space-y-1">
          <span className="text-muted">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} w-full`} autoFocus />
        </label>
        <label className="block space-y-1">
          <span className="text-muted">What to do {ticket && <span className="text-faint">(empty uses the ticket)</span>}</span>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="Describe the outcome you want, and how to check it's done." className={`${inputClass} w-full h-auto py-2`} />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1">
            <span className="block text-muted">Ticket (optional)</span>
            <input value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="ABC-123" className={`${inputClass} w-40 font-mono`} />
          </label>
          <label className="space-y-1 flex-1 min-w-[220px]">
            <span className="block text-muted">Start from (optional)</span>
            <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="The base branch, or a PR to build on, or another branch" className={`${inputClass} w-full`} />
          </label>
        </div>
        <ErrorNote error={err} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !title.trim() || (!prompt.trim() && !ticket.trim())}>
            {busy ? "Starting" : "Start"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function FlowsPage() {
  const flows = useFlows();
  const runs = useRuns();
  const agents = useAgents();
  const names = new Map((agents.data ?? []).map((a) => [a.id, a.name]));
  const [editing, setEditing] = useState<Flow | "new" | null>(null);
  const [starting, setStarting] = useState<Flow | null>(null);
  return (
    <div className="max-w-[1100px] space-y-5">
      <PageHeader title="Flows" sub="Recipes that pass one piece of work between coding agents in one worktree: plan, build, check, review, and back again until it passes.">
        <Button onClick={() => setEditing("new")}>New flow</Button>
      </PageHeader>
      <Panel title="Runs" bodyClass="divide-y divide-line">
        {runs.isLoading && <Loading />}
        <ErrorNote error={runs.error} />
        {runs.data && !runs.data.length && <Empty>No flow has run yet. Pick one below and press Run.</Empty>}
        {runs.data?.map((r) => (
          <Link key={r.id} to="/flows/$id" params={{ id: r.id }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ground text-[13px]">
            <Tag tone={runTone[r.status]}>{r.status}</Tag>
            <span className="flex-1 min-w-0 truncate">
              {r.title} <span className="text-muted">· {r.flow.name}</span>
            </span>
            <span className="flex gap-0.5">
              {r.flow.steps.map((s) => {
                const cur = r.steps.filter((x) => x.step === s.id).sort((a, b) => b.round - a.round)[0];
                return <span key={s.id} title={`${s.name ?? s.id}: ${cur?.status}`} className={`size-2 rounded-full ${dot(cur?.status)}`} />;
              })}
            </span>
            <span className="text-muted w-16 text-right">{ago(r.createdAt)}</span>
          </Link>
        ))}
      </Panel>
      <div className="space-y-2">
        <h2 className="font-semibold">Recipes</h2>
        <ErrorNote error={flows.error} />
        {flows.data?.map((f) => <Recipe key={f.id} f={f} names={names} onEdit={() => setEditing(f)} onRun={() => setStarting(f)} />)}
      </div>
      {editing && <EditFlow flow={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
      {starting && <StartRun flow={starting} onClose={() => setStarting(null)} />}
    </div>
  );
}

const dot = (s?: FlowStepStatus) => ({ running: "bg-cobalt animate-pulse", waiting: "bg-amber", done: "bg-green", failed: "bg-red" })[s as string] ?? "bg-line";

function StepCard({ run, rs, s, names }: { run: FlowRun; rs: FlowRunStep; s: FlowStep; names: Map<string, string> }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(rs.status === "failed" || rs.status === "waiting");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<unknown>();
  const answer = (verdict: "approve" | "changes") =>
    api
      .post(`/flows/runs/${run.id}/steps/${s.id}/answer`, { verdict, note })
      .then(() => qc.invalidateQueries({ queryKey: ["flow-run", run.id] }))
      .catch(setErr);
  const took = rs.startedAt && rs.finishedAt ? Math.max(1, Math.round((rs.finishedAt - rs.startedAt) / 60_000)) : undefined;
  return (
    <div className="rounded-md border border-line bg-panel">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px]">
        <span className={`size-2 rounded-full ${dot(rs.status)}`} />
        <span className="font-medium">{s.name ?? s.id}</span>
        {rs.round > 0 && <span className="text-faint">round {rs.round + 1}</span>}
        <span className="text-muted truncate">· {doer(s, names)}</span>
        <span className="flex-1" />
        {rs.verdict && <Tag tone={rs.verdict === "approve" ? "green" : "amber"}>{rs.verdict}</Tag>}
        <Tag tone={stepTone[rs.status]}>{rs.status}</Tag>
        {took && <span className="text-faint w-12 text-right">{took}m</span>}
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2 space-y-2 text-[13px]">
          {rs.sessionId && (
            <Link to="/sessions/$id" params={{ id: rs.sessionId }} search={{ agent: undefined }} className="text-cobalt hover:underline">
              Open its session
            </Link>
          )}
          {rs.tasks?.length ? (
            <div className="text-muted">
              Queued {rs.tasks.length} task{rs.tasks.length > 1 ? "s" : ""}:{" "}
              {rs.tasks.map((g) => (
                <Link key={g} to="/tasks/$group" params={{ group: g }} className="text-cobalt hover:underline mr-2">
                  {g}
                </Link>
              ))}
            </div>
          ) : null}
          {rs.output && (
            <div className="max-h-[360px] overflow-y-auto rounded bg-ground px-3 py-2">
              <Markdown>{rs.output}</Markdown>
            </div>
          )}
          {rs.status === "waiting" && (
            <div className="space-y-2">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Anything to pass on (optional)" className={`${inputClass} w-full h-auto py-2`} />
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => answer("approve")}>
                  Carry on
                </Button>
                {s.loop && <Button onClick={() => answer("changes")}>Send back to {s.loop.to}</Button>}
              </div>
            </div>
          )}
          <ErrorNote error={err} />
        </div>
      )}
    </div>
  );
}

export function FlowRunPage() {
  const { id } = useParams({ from: "/flows/$id" });
  const qc = useQueryClient();
  useLive((ev) => ev.type === "board" && qc.invalidateQueries({ queryKey: ["flow-run", id] }), [qc, id]);
  const q = useQuery({ queryKey: ["flow-run", id], queryFn: () => api.get<FlowRun>(`/flows/runs/${id}`), refetchInterval: (r) => (["running", "starting"].includes(r.state.data?.status ?? "") ? 4000 : false) });
  const agents = useAgents();
  const names = new Map((agents.data ?? []).map((a) => [a.id, a.name]));
  const [err, setErr] = useState<unknown>();
  const r = q.data;
  if (!r) return q.error ? <ErrorNote error={q.error} /> : <Loading />;
  const rounds = Math.max(...r.steps.map((s) => s.round));
  return (
    <div className="max-w-[900px] space-y-4">
      <div className="text-[13px] text-muted">
        <Link to="/flows" className="hover:text-ink">
          Flows
        </Link>
      </div>
      <PageHeader
        title={r.title}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Tag tone={runTone[r.status]}>{r.status}</Tag>
            <span>{r.flow.name}</span>
            {r.ticket && <span className="font-mono text-[12px]">{r.ticket}</span>}
            {r.branch && <span className="font-mono text-[12px]">{r.branch}</span>}
            {(r.onPr || r.base) && <span>on {r.onPr ?? r.base}</span>}
            <span>{ago(r.createdAt)}</span>
          </span>
        }
      >
        {r.worktree && (
          <Link to="/code" search={{ root: r.worktree }}>
            <Button>Open code</Button>
          </Link>
        )}
        {r.status === "failed" && r.worktree && (
          <Button variant="primary" onClick={() => api.post(`/flows/runs/${id}/retry`).then(() => q.refetch(), setErr)} title="Runs the failed step again, keeping what the others did">
            Retry
          </Button>
        )}
        {["starting", "running", "waiting"].includes(r.status) && (
          <Button variant="danger" onClick={() => confirm("Stop this flow? The worktree stays.") && api.post(`/flows/runs/${id}/cancel`).then(() => q.refetch(), setErr)}>
            Stop
          </Button>
        )}
      </PageHeader>
      <ErrorNote error={err} />
      {r.error && <div className="text-red text-[13px]">{r.error}</div>}
      <details className="text-[13px]">
        <summary className="cursor-pointer text-muted">What it was asked{r.worktree ? ` · ${shortPath(r.worktree)}` : ""}</summary>
        <div className="mt-2 rounded bg-ground px-3 py-2 whitespace-pre-wrap">{r.prompt}</div>
      </details>
      {Array.from({ length: rounds + 1 }, (_, round) => (
        <div key={round} className="space-y-2">
          {rounds > 0 && <h3 className="text-[12px] text-faint uppercase tracking-wide">Round {round + 1}</h3>}
          {r.flow.steps.map((s) => {
            const rs = r.steps.find((x) => x.step === s.id && x.round === round);
            return rs ? <StepCard key={`${s.id}-${round}`} run={r} rs={rs} s={s} names={names} /> : null;
          })}
        </div>
      ))}
    </div>
  );
}
