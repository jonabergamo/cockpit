import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Task } from "@cockpit/shared";
import { api } from "../lib/api";
import { useAppConfig, useTickets } from "../lib/queries";
import { useSettings } from "../lib/cost";
import { Button, ErrorNote, inputClass, Modal, Tabs } from "./ui";

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

const MODELS = ["", "opus", "sonnet", "haiku"];

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
  const [attempts, setAttempts] = useState<"1" | "2" | "3">("1");
  const [model, setModel] = useState("");
  const [kind, setKind] = useState("");
  const kinds = useSettings().data?.settings.templates ?? [];
  const [after, setAfter] = useState("");
  const [onPr, setOnPr] = useState("");
  const [overnight, setOvernight] = useState(false);
  const [busy, setBusy] = useState(false);
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
  }, [s.open, s.ticket, s.after, s.onPr, tickets.data]);

  const pickTicket = (key: string) => {
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
      await api.post<Task[]>("/tasks", { title, prompt, ticket: ticket || undefined, attempts: Number(attempts), model: model || undefined, template: kind || undefined, dependsOn: after ? [after] : [], onPr: onPr.trim() || undefined, overnight: overnight || undefined });
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
        <p className="text-muted">Cockpit makes a worktree and branch for it and starts Claude there. With more than one attempt, each gets its own, so you can keep the best.</p>
        {cfg.data?.tracker && !!tickets.data?.tickets.length && (
          <label className="block space-y-1">
            <span className="text-muted">Ticket (optional)</span>
            <select value={ticket} onChange={(e) => pickTicket(e.target.value)} className={`${inputClass} w-full`}>
              <option value="">None</option>
              {tickets.data.tickets.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.key} · {t.summary}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block space-y-1">
          <span className="text-muted">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Saved cards on the checkout page" className={`${inputClass} w-full`} autoFocus />
        </label>
        <label className="block space-y-1">
          <span className="text-muted">What Claude should do {ticket && <span className="text-faint">(empty uses the ticket)</span>}</span>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="Describe the outcome you want, and how to check it's done." className={`${inputClass} w-full h-auto py-2`} />
        </label>
        <label className="block space-y-1">
          <span className="text-muted">
            On top of a PR <span className="text-faint">(optional, someone's open PR your work needs)</span>
          </span>
          <input value={onPr} onChange={(e) => setOnPr(e.target.value)} placeholder="Paste a PR link or number. Empty starts from the main branch" className={`${inputClass} w-full`} />
          {onPr.trim() && <span className="block text-[12px] text-faint">Its branch is the starting point. When that PR gets new commits or merges, the Board says so and can hand the catching up to Claude.</span>}
        </label>
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <span className="block text-muted">Attempts</span>
            <Tabs value={attempts} onChange={setAttempts} items={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }]} />
          </div>
          {kinds.length > 0 && (
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
          <label className="space-y-1">
            <span className="block text-muted">Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} className={inputClass}>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m || "Default"}
                </option>
              ))}
            </select>
          </label>
          {groups.length > 0 && (
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
        <label className="flex items-start gap-2 text-[13px] cursor-pointer">
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
          <Button variant="primary" disabled={busy || !title.trim() || (!prompt.trim() && !ticket)}>
            {busy ? "Queueing" : overnight ? "Queue for tonight" : Number(attempts) > 1 ? `Queue ${attempts} attempts` : "Queue it"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
