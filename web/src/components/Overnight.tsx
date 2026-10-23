import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TaskStatus } from "@cockpit/shared";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { Button, ErrorNote, Tag } from "./ui";

interface NightRes {
  on: boolean;
  since?: number;
  endedAt?: number;
  by?: "you" | "hours";
  why?: string;
  unit: "usd" | "tokens";
  cap?: number;
  spent: number;
  done: number;
  failed: number;
  left: number;
  tasks: { id: string; group: string; title: string; status: TaskStatus; error?: string; spent: number }[];
}

const amount = (n: number, unit: NightRes["unit"]) => (unit === "usd" ? `$${n.toFixed(2)}` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tokens` : `${Math.round(n / 1e3)}k tokens`);
const tone = (s: TaskStatus) => (s === "done" ? "green" : s === "failed" || s === "cancelled" ? "red" : s === "running" || s === "starting" ? "cobalt" : "faint") as "green" | "red" | "cobalt" | "faint";

// The overnight queue on Today: start it when you leave, and see what it did when you're back
export function Overnight() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["overnight"], queryFn: () => api.get<NightRes>("/tasks/overnight"), refetchInterval: (x) => (x.state.data?.on ? 30_000 : false) });
  const set = useMutation({ mutationFn: (on: boolean) => api.post<NightRes>("/tasks/overnight", { on }), onSuccess: (n) => (qc.setQueryData(["overnight"], n), qc.invalidateQueries({ queryKey: ["board"] })) });
  const n = q.data;
  // a night that ended more than a day ago isn't news, and with nothing waiting there's nothing to start
  const recent = !!n?.endedAt && Date.now() - n.endedAt < 24 * 3600_000 && n.tasks.length > 0;
  if (!n || (!n.on && !n.left && !recent)) return null;
  const cap = n.cap ? ` of ${amount(n.cap, n.unit)}` : "";
  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-2.5">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold">Overnight queue</h2>
          <p className="text-[13px] text-muted">
            {n.on
              ? `Running since ${ago(n.since)}${n.by === "hours" ? ", for your night hours" : ""}. ${amount(n.spent, n.unit)}${cap} used, ${n.left} still waiting.`
              : recent
                ? `${n.why ?? "Ended"} ${ago(n.endedAt)}: ${n.done} done, ${n.failed} failed, ${amount(n.spent, n.unit)}${cap} used.${n.left ? ` ${n.left} still waiting for the next night.` : ""}`
                : `${n.left} ${n.left === 1 ? "task is" : "tasks are"} waiting for it. They run one after another while you're away, and stop at the night's cap.`}
          </p>
        </div>
        <Button variant={n.on ? "default" : "primary"} disabled={set.isPending} onClick={() => set.mutate(!n.on)}>
          {n.on ? "I'm back" : "I'm off, run it"}
        </Button>
      </div>
      {n.tasks.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {n.tasks.map((t) => (
            <Link key={t.id} to="/tasks/$group" params={{ group: t.group }} className="flex items-center gap-2 py-1.5 text-[13px] hover:text-cobalt">
              <span className="flex-1 min-w-0 truncate" title={t.error}>
                {t.title}
                {t.error && <span className="text-faint"> · {t.error}</span>}
              </span>
              {t.spent > 0 && <span className="text-[12px] text-faint tabular-nums">{amount(t.spent, n.unit)}</span>}
              <Tag tone={tone(t.status)}>{t.status}</Tag>
            </Link>
          ))}
        </div>
      )}
      <ErrorNote error={set.error} />
    </section>
  );
}
