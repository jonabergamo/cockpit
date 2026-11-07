import { type Node, type NodeProps } from "@xyflow/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { PlanStep, SessionPlan, SessionStatus } from "@cockpit/shared";
import { useAgentName } from "../../lib/agent";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { Markdown } from "../ui";
import { useActions, type CardTone } from "./context";
import { useFit } from "./fit";
import { Ports } from "./LinkEdge";

// whose plan it shows: the agent in the terminal it's linked to
export type PlanFrom = { term: string; session?: string; label: string; status?: SessionStatus };
export type PlanData = { from?: PlanFrom; fit?: boolean };
export type PlanCardNode = Node<PlanData, "plan">;

const MARK: Record<PlanStep["status"], string> = { done: "✓", doing: "◐", todo: "○" };
const MARK_TONE: Record<PlanStep["status"], string> = { done: "text-green", doing: "text-cobalt", todo: "text-faint" };

// What the agent in the terminal it's linked to is working through: the plan it asked to go ahead with (plan
// mode), its to-do list when it keeps one, ticked off as it goes, and what it's doing right now.
export function PlanCard({ id, data, selected }: NodeProps<PlanCardNode>) {
  const a = useActions();
  const agent = useAgentName();
  const from = data.from;
  const busy = from?.status === "busy";
  const q = useQuery({
    queryKey: ["plan", from?.session],
    queryFn: () => api.get<SessionPlan>(`/sessions/${from!.session}/plan`),
    enabled: !!from?.session,
    // a working agent changes it every few seconds; an idle one only when it starts again
    refetchInterval: busy ? 3000 : 20_000,
  });
  const p = q.data;
  const todos = p?.todos ?? [];
  const done = todos.filter((t) => t.status === "done").length;
  const now = p?.doing[0];
  const [whole, setWhole] = useState(false);
  const tone: CardTone | undefined = busy ? "running" : todos.length && done === todos.length ? "pass" : undefined;
  useEffect(() => a.tone(id, tone), [id, tone, a]);
  const fit = useFit({ id, selected, fit: data.fit, max: 620, minWidth: 280, minHeight: 120 });
  const empty = p && !p.plan && !todos.length && !p.doing.length;
  return (
    <div className={`w-full flex flex-col rounded-lg border bg-panel shadow-lg overflow-hidden text-[12px] ${selected ? "border-cobalt" : "border-line"}`} style={fit.style} data-plan={id}>
      {fit.resizer}
      <Ports />
      <div className="card-handle cursor-grab active:cursor-grabbing flex items-center gap-2 h-8 pl-2.5 pr-1 bg-raised border-b border-line shrink-0" onDoubleClick={() => a.bringUp(id)} title="Drag to move, double-click to bring it up">
        <span className="font-medium">Plan</span>
        {from && <span className="truncate text-faint">{from.label}</span>}
        {todos.length > 0 && (
          <span className={`ml-auto shrink-0 tabular-nums ${done === todos.length ? "text-green" : "text-muted"}`} data-plan-count>
            {done} of {todos.length} done
          </span>
        )}
        <button type="button" onClick={() => a.removeCard(id)} className={`nodrag size-6 grid place-items-center rounded text-faint hover:text-red hover:bg-ground shrink-0 ${todos.length ? "" : "ml-auto"}`} title="Take this card off the canvas" aria-label="Remove plan card">
          ×
        </button>
      </div>
      <div className="nowheel flex-auto min-h-0 overflow-y-auto">
        {!from ? (
          <div className="px-4 py-6 text-center text-muted">Draw a line from this card to a terminal, and it shows what its agent is working through and doing now.</div>
        ) : !from.session ? (
          <div className="px-4 py-6 text-center text-muted">No agent in {from.label} yet. Once {agent} starts there, its plan shows up here.</div>
        ) : q.error ? (
          <div className="px-4 py-6 text-center text-muted">Couldn't read its plan: {q.error instanceof Error ? q.error.message : String(q.error)}</div>
        ) : !p ? (
          <div className="px-4 py-6 text-center text-faint">Reading its session</div>
        ) : empty ? (
          <div className="px-4 py-6 text-center text-muted">Nothing yet. When {agent} plans (plan mode) or keeps a to-do list, it shows here, along with what it's doing.</div>
        ) : (
          <>
            {now && (
              <div className="px-3 py-2 border-b border-line" data-plan-now>
                <div className="text-[11px] text-faint mb-1">{busy ? "Doing now" : "Last did"}</div>
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`size-2 rounded-full shrink-0 ${busy && !now.done ? "bg-cobalt animate-pulse" : "bg-line"}`} />
                  <span className="truncate font-medium" title={now.what}>
                    {now.what}
                  </span>
                </div>
                {p.doing.length > 1 && (
                  <ul className="mt-1 pl-4 text-muted">
                    {p.doing.slice(1, 4).map((d, i) => (
                      <li key={i} className="truncate" title={d.what}>
                        {d.what}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {todos.length > 0 && (
              <ul className="px-3 py-2 border-b border-line flex flex-col gap-0.5" aria-label="Its to-do list">
                {todos.map((t, i) => (
                  <li key={i} className="flex gap-2 min-w-0" data-step={t.status}>
                    <span className={`shrink-0 w-3 text-center ${MARK_TONE[t.status]}`}>{MARK[t.status]}</span>
                    <span className={t.status === "done" ? "text-faint line-through" : t.status === "doing" ? "font-medium" : ""}>{t.text}</span>
                  </li>
                ))}
              </ul>
            )}
            {p.plan && (
              <div className="px-3 py-2" data-plan-text>
                <div className="flex items-center gap-2 text-[11px] mb-1">
                  <span className="text-faint">The plan</span>
                  <span className={p.plan.approved ? "text-green" : "text-amber"}>{p.plan.approved ? "approved" : p.plan.approved === false ? "not approved" : "waiting for you"}</span>
                  <span className="text-faint" title={p.plan.at}>
                    {ago(Date.parse(p.plan.at))}
                  </span>
                  <button type="button" onClick={() => setWhole(!whole)} className="nodrag ml-auto text-cobalt hover:underline">
                    {whole ? "Just the steps" : "The whole plan"}
                  </button>
                </div>
                {whole || !p.plan.steps.length ? (
                  <div className="nodrag select-text text-[12px]">
                    <Markdown>{p.plan.text}</Markdown>
                  </div>
                ) : (
                  <ol className="list-decimal pl-5 flex flex-col gap-0.5">
                    {p.plan.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
