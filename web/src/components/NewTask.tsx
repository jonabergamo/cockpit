import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentInfo, CreateOptions, Flow, FlowRun, NewTicket, Task, Ticket } from "@cockpit/shared";
import { api } from "../lib/api";
import { useAgents, useAppConfig, useTickets } from "../lib/queries";
import { useSettings } from "../lib/cost";
import { Button, ErrorNote, inputClass, Modal, Tabs } from "./ui";
import { TicketPicker } from "./TicketPicker";

// Opened from the Board, a ticket and ⌘K, so the open state lives outside them all.
let state: { open: boolean; ticket?: string; after?: string; onPr?: string } = { open: false };
const listeners = new Set<() => void>();
const set = (s: typeof state) => {
  state = s;
  listeners.forEach((l) => l());
};
export const newTask = { open: (prefill: { ticket?: string; after?: string; onPr?: string } = {}) => set({ open: true, ...prefill }), close: () => set({ open: false }) };
const useNewTask = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => state,
  );

// one attempt: which agent and model; empty is the default
type Attempt = { agent: string; model: string };

export function NewTaskModal() {
  const s = useNewTask();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cfg = useAppConfig();
  const tickets = useTickets();
  const active = useQuery({ queryKey: ["tasks"], queryFn: () => api.get<Task[]>("/tasks"), enabled: s.open });
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ticket, setTicket] = useState("");
  const [attempts, setAttempts] = useState<Attempt[]>([{ agent: "", model: "" }]);
  const agents = useAgents(s.open);
  // a flow instead of a single agent: its steps pass the work between agents in one worktree
  const [flow, setFlow] = useState("");
  const flows = useQuery({ queryKey: ["flows"], queryFn: () => api.get<Flow[]>("/flows"), enabled: s.open });
  const [kind, setKind] = useState("");
  const base = cfg.data?.baseBranch ?? "main";
  const settings = useSettings().data?.settings;
  const kinds = settings?.templates ?? [];
  const [after, setAfter] = useState("");
  const [onPr, setOnPr] = useState("");
  const [overnight, setOvernight] = useState(false);
  const [busy, setBusy] = useState(false);
  // a ticket to make in the tracker before the task is queued on it
  const [draft, setDraft] = useState<NewTicket | null>(null);
  const createOpts = useQuery({ queryKey: ["tickets", "new"], queryFn: () => api.get<CreateOptions | null>("/tickets/new"), enabled: s.open && !!cfg.data?.tracker, staleTime: 5 * 60_000 });
  const [err, setErr] = useState<unknown>();

  useEffect(() => {
    if (!s.open) return;
    setErr(undefined);
    setTicket(s.ticket ?? "");
    setAfter(s.after ?? "");
    const t = tickets.data?.tickets.find((x) => x.key === s.ticket);
    setTitle(t ? t.summary : "");
    setPrompt("");
    setOnPr(s.onPr ?? "");
    setOvernight(false);
    setDraft(null);
  }, [s.open, s.ticket, s.after, s.onPr, tickets.data]);

  const pickTicket = (key: string) => {
    setDraft(null);
    setTicket(key);
    const t = tickets.data?.tickets.find((x) => x.key === key);
    if (t && !title) setTitle(t.summary);
  };
  // one entry per group: what can still be waited on
  const groups = [...new Map((active.data ?? []).filter((t) => !["cancelled", "failed"].includes(t.status)).map((t) => [t.group, t])).values()];

  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      let key = ticket;
      if (draft) {
        const made = await api.post<Ticket>("/tickets/new", { ...draft, summary: draft.summary.trim() || title.trim(), description: draft.description?.trim() || prompt.trim() || undefined });
        key = made.key;
        // made once: asking again after the task fails to queue uses this ticket rather than making another
        setTicket(key);
        setDraft(null);
        qc.invalidateQueries({ queryKey: ["tickets"] });
      }
      if (flow) {
        const run = await api.post<FlowRun>("/flows/runs", { flow, title, prompt, ticket: key || undefined, from: onPr.trim() || undefined });
        newTask.close();
        setTitle("");
        setPrompt("");
        navigate({ to: "/flows/$id", params: { id: run.id } });
        return;
      }
      const lineup = attempts.map((a) => ({ agent: a.agent || undefined, model: a.model || undefined }));
      await api.post<Task[]>("/tasks", { title, prompt, ticket: key || undefined, lineup, template: kind || undefined, dependsOn: after ? [after] : [], onPr: onPr.trim() || undefined, overnight: overnight || undefined });
      await Promise.all([qc.invalidateQueries({ queryKey: ["board"] }), qc.invalidateQueries({ queryKey: ["tasks"] })]);
      newTask.close();
      setTitle("");
      setPrompt("");
      navigate({ to: "/board" });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={s.open} onClose={newTask.close} title="New task" wide>
      <form
        className="space-y-3 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-muted">Cockpit makes a worktree and branch for it and starts a coding agent there. With more than one attempt, each gets its own, so you can keep the best, or compare agents.</p>
        {cfg.data?.tracker && (!!tickets.data?.tickets.length || !!createOpts.data) && (
          <div className="space-y-1">
            <span className="block text-muted">Ticket (optional)</span>
            <TicketPicker
              value={ticket}
              onChange={pickTicket}
              tickets={tickets.data?.tickets ?? []}
              epics={tickets.data?.epics ?? []}
              statusOrder={cfg.data.statusOrder}
              creating={!!draft}
              onCreate={
                createOpts.data
                  ? (summary) => {
                      setTicket("");
                      setDraft({ summary: summary || title, type: createOpts.data!.types[0], preset: createOpts.data!.presets[0], inSprint: createOpts.data!.sprint, fields: {} });
                      if (summary && !title) setTitle(summary);
                    }
                  : undefined
              }
            />
          </div>
        )}
        {draft && createOpts.data && <CreateTicket draft={draft} onChange={setDraft} options={createOpts.data} epics={tickets.data?.epics ?? []} tracker={cfg.data?.tracker?.name ?? "the tracker"} />}
        <label className="block space-y-1">
          <span className="text-muted">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Saved cards on the checkout page" className={`${inputClass} w-full`} autoFocus />
        </label>
        <label className="block space-y-1">
          <span className="text-muted">What it should do {(ticket || draft) && <span className="text-faint">(empty uses the ticket)</span>}</span>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="Describe the outcome you want, and how to check it's done." className={`${inputClass} w-full h-auto py-2`} />
        </label>
        <label className="block space-y-1">
          <span className="text-muted">
            Start from <span className="text-faint">(optional, its PR goes back there)</span>
          </span>
          <input value={onPr} onChange={(e) => setOnPr(e.target.value)} placeholder={`${base}. Or another branch, or a PR link or number to build on`} className={`${inputClass} w-full`} />
          {onPr.trim() && onPr.trim() !== base && (
            <span className="block text-[12px] text-faint">
              {/^(#?\d+|https?:\/\/\S+)$/.test(onPr.trim())
                ? "Its branch is the starting point. When that PR gets new commits or merges, the Board says so and can hand the catching up to Claude."
                : `That branch on origin is the starting point, and the PR targets it instead of ${base}.`}
            </span>
          )}
        </label>
        {!!flows.data?.length && (
          <label className="block space-y-1">
            <span className="text-muted">Run it as</span>
            <select value={flow} onChange={(e) => setFlow(e.target.value)} className={`${inputClass} w-full`}>
              <option value="">A task, with the agents below</option>
              {flows.data.map((f) => (
                <option key={f.id} value={f.id}>
                  Flow: {f.name}
                </option>
              ))}
            </select>
            {flow && <span className="block text-[12px] text-faint">{flows.data.find((f) => f.id === flow)?.description}</span>}
          </label>
        )}
        {!flow && <Attempts value={attempts} onChange={setAttempts} agents={(agents.data ?? []).filter((a) => a.installed && a.enabled)} fallback={settings?.tasks.defaultAgent || "claude"} />}
        <div className="flex flex-wrap items-end gap-4">
          {!flow && kinds.length > 0 && (
            <label className="space-y-1">
              <span className="block text-muted">Kind of work</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
                <option value="">{(ticket && tickets.data?.tickets.find((x) => x.key === ticket)?.kind) || "Matched by the ticket"}</option>
                {kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!flow && groups.length > 0 && (
            <label className="space-y-1 flex-1 min-w-[180px]">
              <span className="block text-muted">Start after</span>
              <select value={after} onChange={(e) => setAfter(e.target.value)} className={`${inputClass} w-full`}>
                <option value="">Right away</option>
                {groups.map((t) => (
                  <option key={t.group} value={t.group}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label className={`flex items-start gap-2 text-[13px] cursor-pointer ${flow ? "hidden" : ""}`}>
          <input type="checkbox" checked={overnight} onChange={(e) => setOvernight(e.target.checked)} className="mt-0.5 size-4 accent-[var(--cobalt)]" />
          <span>
            Overnight
            <span className="block text-[12px] text-faint">Waits until you start the overnight queue from Today (or your night hours in Settings), then runs without asking you anything and stops at the night's cap.</span>
          </span>
        </label>
        <ErrorNote error={err} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={newTask.close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !title.trim() || (!prompt.trim() && !ticket && !draft)}>
            {busy ? (draft ? "Making the ticket" : "Queueing") : draft ? "Make the ticket and queue it" : flow ? "Start the flow" : overnight ? "Queue for tonight" : attempts.length > 1 ? `Queue ${attempts.length} attempts` : "Queue it"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// Who works on it: one row per attempt, each an agent and one of its models. The same agent twice gives independent
// tries; different ones compare agents on the same work.
function Attempts({ value, onChange, agents, fallback }: { value: Attempt[]; onChange: (a: Attempt[]) => void; agents: AgentInfo[]; fallback: string }) {
  const set = (i: number, p: Partial<Attempt>) => onChange(value.map((a, j) => (j === i ? { ...a, ...p } : a)));
  const models = (id: string) => agents.find((a) => a.id === (id || fallback))?.models ?? [];
  return (
    <div className="space-y-1">
      <span className="block text-muted">{value.length > 1 ? `Attempts (${value.length})` : "Agent"}</span>
      {value.map((a, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <select value={a.agent} onChange={(e) => set(i, { agent: e.target.value, model: "" })} className={inputClass} aria-label="Agent">
            <option value="">Default ({agents.find((x) => x.id === fallback)?.name ?? fallback})</option>
            {agents.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <select value={a.model} onChange={(e) => set(i, { model: e.target.value })} className={inputClass} aria-label="Model">
            <option value="">Default model</option>
            {models(a.agent).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {value.length > 1 && (
            <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="text-[12px] text-muted hover:text-ink" aria-label="Remove this attempt">
              Remove
            </button>
          )}
        </div>
      ))}
      {value.length < 4 && (
        <button type="button" onClick={() => onChange([...value, { ...value[value.length - 1] }])} className="text-[12px] text-cobalt hover:underline">
          + Another attempt
        </button>
      )}
    </div>
  );
}

// What the new ticket gets: its summary, type, the preset of fields it's filed with, its epic, the sprint, and the
// fields the tracker asks for (acceptance criteria, points). The description defaults to what Claude should do.
function CreateTicket({ draft, onChange, options, epics, tracker }: { draft: NewTicket; onChange: (d: NewTicket | null) => void; options: CreateOptions; epics: { key: string; summary: string }[]; tracker: string }) {
  const set = (p: Partial<NewTicket>) => onChange({ ...draft, ...p });
  const field = (k: string, v: string | number) => set({ fields: { ...draft.fields, [k]: v } });
  return (
    <div className="space-y-3 rounded-md border border-line bg-ground p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">New ticket in {tracker}</span>
        <button type="button" onClick={() => onChange(null)} className="text-[12px] text-muted hover:text-ink">
          Don't make one
        </button>
      </div>
      <label className="block space-y-1">
        <span className="text-muted">Summary <span className="text-faint">(empty uses the title)</span></span>
        <input value={draft.summary} onChange={(e) => set({ summary: e.target.value })} className={`${inputClass} w-full`} />
      </label>
      <div className="flex flex-wrap items-end gap-4">
        {options.types.length > 1 && (
          <div className="space-y-1">
            <span className="block text-muted">Type</span>
            <Tabs value={draft.type ?? options.types[0]} onChange={(type) => set({ type })} items={options.types.map((t) => ({ value: t, label: t }))} />
          </div>
        )}
        {options.presets.length > 1 && (
          <div className="space-y-1">
            <span className="block text-muted">Filed as</span>
            <Tabs value={draft.preset ?? options.presets[0]} onChange={(preset) => set({ preset })} items={options.presets.map((p) => ({ value: p, label: p }))} />
          </div>
        )}
        {epics.length > 0 && (
          <label className="space-y-1 flex-1 min-w-[180px]">
            <span className="block text-muted">Epic</span>
            <select value={draft.parent ?? ""} onChange={(e) => set({ parent: e.target.value || undefined })} className={`${inputClass} w-full`}>
              <option value="">None</option>
              {epics.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.key} · {e.summary}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {options.sprint && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={!!draft.inSprint} onChange={(e) => set({ inSprint: e.target.checked })} className="size-4 accent-[var(--cobalt)]" />
          Add it to the current sprint
        </label>
      )}
      {options.fields.map((f) => (
        <label key={f.key} className="block space-y-1">
          <span className="text-muted">
            {f.label} {f.help && <span className="text-faint">({f.help})</span>}
          </span>
          {f.kind === "lines" ? (
            <textarea value={String(draft.fields?.[f.key] ?? "")} onChange={(e) => field(f.key, e.target.value)} rows={3} placeholder="One per line" className={`${inputClass} w-full h-auto py-2`} />
          ) : (
            <input
              type={f.kind === "number" ? "number" : "text"}
              value={String(draft.fields?.[f.key] ?? "")}
              onChange={(e) => field(f.key, f.kind === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}
              className={`${inputClass} block ${f.kind === "number" ? "w-24" : "w-full"}`}
            />
          )}
        </label>
      ))}
      <label className="block space-y-1">
        <span className="text-muted">Description <span className="text-faint">(empty uses what Claude should do)</span></span>
        <textarea value={draft.description ?? ""} onChange={(e) => set({ description: e.target.value })} rows={3} className={`${inputClass} w-full h-auto py-2`} />
      </label>
    </div>
  );
}
