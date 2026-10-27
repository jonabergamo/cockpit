import type { TicketSpend } from "@cockpit/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { useCost } from "../lib/cost";
import { Button, ErrorNote, Tag, inputClass } from "./ui";

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

function useAmount() {
  const cost = useCost();
  return (n: number | undefined, unit: TicketSpend["unit"]) => (n === undefined ? "" : unit === "usd" ? cost.fmt(n) || "$0.00" : `${tokens(n)} tokens`);
}

const toneOf = (s: TicketSpend) => (!s.limit ? "plain" : s.spent >= s.limit ? "red" : s.spent >= (s.limit * s.warnPct) / 100 ? "amber" : "plain");

// "$4.20 of $10" or "2.1M of 5.0M tokens" on a card or a ticket row; nothing when nothing was used
export function SpendTag({ spend }: { spend?: TicketSpend }) {
  const cost = useCost();
  const amount = useAmount();
  if (!spend || (!spend.spent && !spend.limit)) return null;
  const what = spend.unit === "usd" ? cost.label : "New tokens";
  const text = spend.unit === "usd" ? `${amount(spend.spent, "usd")}${spend.limit ? ` of ${amount(spend.limit, "usd")}` : ""}` : `${tokens(spend.spent)}${spend.limit ? ` of ${tokens(spend.limit)}` : ""} tokens`;
  return (
    <Tag tone={toneOf(spend)} title={`${what} across this ticket's sessions${spend.limit ? `, against a budget of ${amount(spend.limit, spend.unit)}` : ""}`}>
      {text}
    </Tag>
  );
}

// The ticket's spend with a bar, and its own budget: a number, none, or back to the default from Settings.
export function BudgetEditor({ ticket, spend }: { ticket: string; spend?: TicketSpend }) {
  const qc = useQueryClient();
  const cost = useCost();
  const amount = useAmount();
  const unit = spend?.unit ?? (cost.hidden ? "tokens" : "usd");
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState("");
  const [err, setErr] = useState<unknown>();
  const spent = spend?.spent ?? 0;
  const pct = spend?.limit ? Math.min(100, (spent / spend.limit) * 100) : 0;
  const save = async (n: number | null) => {
    setErr(undefined);
    try {
      await api.put(`/budgets/${encodeURIComponent(ticket)}`, { amount: n === null ? null : unit === "usd" ? n : n * 1e6 });
      await Promise.all([qc.invalidateQueries({ queryKey: ["board"] }), qc.invalidateQueries({ queryKey: ["tickets"] })]);
      setEditing(false);
    } catch (e) {
      setErr(e);
    }
  };
  const commit = () => {
    const n = Number(v.replace(/[$\sMm]/g, ""));
    if (Number.isFinite(n) && n >= 0) save(n);
    else setErr(new Error(unit === "usd" ? "A number of dollars, 0 for no budget" : "Millions of tokens, 0 for no budget"));
  };

  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-[13px] flex-1">
          {unit === "usd" ? cost.label : "Tokens"} <span className="text-faint font-normal">· {amount(spent, unit)}{spend?.limit ? ` of ${amount(spend.limit, unit)}` : ", no budget"}</span>
        </h3>
        {!editing && (
          <Button size="sm" variant="ghost" onClick={() => (setV(spend?.limit ? String(unit === "usd" ? spend.limit : +(spend.limit / 1e6).toFixed(1)) : ""), setEditing(true))}>
            {spend?.limit ? "Change budget" : "Set a budget"}
          </Button>
        )}
      </div>
      {spend?.limit ? (
        <div className="h-1.5 rounded-full bg-ground overflow-hidden">
          <div className={`h-full ${toneOf(spend) === "red" ? "bg-red" : toneOf(spend) === "amber" ? "bg-amber" : "bg-cobalt"}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {editing && (
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          {unit === "usd" && <span className="text-muted">$</span>}
          <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? commit() : e.key === "Escape" && setEditing(false))} inputMode="decimal" placeholder={unit === "usd" ? "10" : "5"} className={`${inputClass} w-24 text-right tabular-nums`} />
          {unit === "tokens" && <span className="text-muted">million tokens</span>}
          <Button size="sm" variant="primary" onClick={commit}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => save(null)} title="Use the budget from Settings">
            Use the default
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      )}
      <p className="text-[12px] text-faint">
        Every session on this ticket counts, whichever agent ran it{unit === "tokens" ? ", in new tokens (input, output and cache writes)" : ""}. Cockpit tells you at {spend?.warnPct ?? 80}% and again when it goes over.
      </p>
      <ErrorNote error={err} />
    </section>
  );
}
