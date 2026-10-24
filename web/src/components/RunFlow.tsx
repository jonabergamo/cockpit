import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Flow, FlowRun } from "@cockpit/shared";
import { api } from "../lib/api";
import { shortPath } from "../lib/format";
import { useWorktrees } from "../lib/queries";
import { Button, ErrorNote, inputClass, Modal } from "./ui";

// Opened from the Flows screen, a worktree's card and a session, so the open state lives outside them all
let state: { open: boolean; flow?: string; worktree?: string } = { open: false };
const listeners = new Set<() => void>();
const set = (s: typeof state) => {
  state = s;
  listeners.forEach((l) => l());
};
export const runFlow = { open: (prefill: { flow?: string; worktree?: string } = {}) => set({ open: true, ...prefill }), close: () => set({ open: false }) };
const useRunFlow = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => state,
  );

const NEW = "";

// A flow on some work: in a worktree that's already there (more work on what it holds, like an epic's) or a new one
export function RunFlowModal() {
  const s = useRunFlow();
  const navigate = useNavigate();
  const flows = useQuery({ queryKey: ["flows"], queryFn: () => api.get<(Flow & { problem?: string })[]>("/flows"), enabled: s.open });
  const worktrees = useWorktrees();
  const [flow, setFlow] = useState("");
  const [where, setWhere] = useState(NEW);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ticket, setTicket] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();

  useEffect(() => {
    if (!s.open) return;
    setFlow(s.flow ?? "");
    setWhere(s.worktree ?? NEW);
    setTitle("");
    setPrompt("");
    setTicket(worktrees.data?.find((w) => w.path === s.worktree)?.ticket ?? "");
    setFrom("");
    setErr(undefined);
    setBusy(false);
  }, [s.open, s.flow, s.worktree, worktrees.data]);

  const list = flows.data ?? [];
  const picked = list.find((f) => f.id === (flow || list[0]?.id));
  const places = (worktrees.data ?? []).filter((w) => !w.main);
  const go = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.post<FlowRun>("/flows/runs", { flow: picked?.id, title, prompt, ticket: ticket.trim() || undefined, from: where === NEW ? from.trim() || undefined : undefined, worktree: where === NEW ? undefined : where });
      runFlow.close();
      navigate({ to: "/flows/$id", params: { id: r.id } });
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };

  return (
    <Modal open={s.open} onClose={runFlow.close} title="Run a flow" wide>
      <form
        className="space-y-3 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1 flex-1 min-w-[200px]">
            <span className="block text-muted">Flow</span>
            <select value={picked?.id ?? ""} onChange={(e) => setFlow(e.target.value)} className={`${inputClass} w-full`}>
              {list.map((f) => (
                <option key={f.id} value={f.id} disabled={!!f.problem}>
                  {f.name}
                  {f.problem ? " (needs fixing)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 flex-1 min-w-[260px]">
            <span className="block text-muted">Where</span>
            <select value={where} onChange={(e) => setWhere(e.target.value)} className={`${inputClass} w-full`}>
              <option value={NEW}>A new worktree, for new work</option>
              {places.map((w) => (
                <option key={w.path} value={w.path}>
                  {w.ticket ? `${w.ticket} · ` : ""}
                  {w.branch ?? w.name} {w.node ? `(on ${w.node})` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        {picked?.description && <p className="text-[12px] text-faint">{picked.description}</p>}
        {where !== NEW && <p className="text-[12px] text-faint">It works on the branch checked out in {shortPath(where)}, next to whatever else is going on there, and shows on that worktree's card.</p>}
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
          {where === NEW && (
            <label className="space-y-1 flex-1 min-w-[220px]">
              <span className="block text-muted">Start from (optional)</span>
              <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="The base branch, or a PR to build on, or another branch" className={`${inputClass} w-full`} />
            </label>
          )}
        </div>
        <ErrorNote error={err} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={runFlow.close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !picked || !title.trim() || (!prompt.trim() && !ticket.trim())}>
            {busy ? "Starting" : "Start"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
