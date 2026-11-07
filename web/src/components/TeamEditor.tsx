import { useState } from "react";
import type { KitLine, KitMember, KitTeam } from "@cockpit/shared";
import { teamText } from "../lib/kits";
import { Button, inputClass } from "./ui";

const ROLES: { value: KitLine["role"]; label: string }[] = [
  { value: "review", label: "reviews it" },
  { value: "plan", label: "plans from it" },
  { value: "build", label: "carries on with it" },
  { value: "custom", label: "in your words" },
];
const CARDS: KitMember["cards"] = ["plan", "changes", "runs"];
const small = `${inputClass} h-7 text-[12px] px-1.5`;
const newId = () => `t${Math.random().toString(36).slice(2, 7)}`;

// A kind of work's team: the terminals a ticket of it starts with (the first is the main one), and the lines
// between them that pass their turns along. None set is the usual pair, shown as such.
export function TeamEditor({ team, fallback, onChange }: { team?: KitTeam; fallback?: KitTeam; onChange: (t: KitTeam | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const shown = team ?? fallback;
  const set = (patch: Partial<KitTeam>) => onChange({ ...(team ?? fallback ?? { worktree: true, terms: [], lines: [] }), ...patch });
  const t = team ?? fallback;
  const term = (i: number, patch: Partial<KitMember>) => t && set({ terms: t.terms.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const line = (i: number, patch: Partial<KitLine>) => t && set({ lines: t.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  return (
    <div className="rounded border border-line/70 bg-ground/40" data-team>
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-[12px]" aria-expanded={open}>
        <span className="text-faint">{open ? "▾" : "▸"}</span>
        <span className="font-medium">Team</span>
        <span className="text-muted truncate" data-team-text>
          {shown ? teamText(shown) : "the usual pair"}
          {!team && " (the usual pair)"}
        </span>
      </button>
      {open && t && (
        <div className="px-2 pb-2 space-y-2 text-[12px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={t.worktree} onChange={(e) => set({ worktree: e.target.checked })} />
            Its own worktree <span className="text-faint">(off: it works in the repo as it is, for work with no code)</span>
          </label>
          <div className="space-y-1.5" aria-label="Its terminals">
            {t.terms.map((m, i) => (
              <div key={m.id} className="rounded border border-line bg-raised p-1.5 space-y-1" data-member={m.id}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-faint w-10">{i === 0 ? "main" : `#${i + 1}`}</span>
                  <input value={m.name} onChange={(e) => term(i, { name: e.target.value })} className={`${small} w-32`} aria-label="Terminal name" placeholder="fixer" />
                  <select value={m.agent ?? ""} onChange={(e) => term(i, { agent: e.target.value || undefined })} className={small} aria-label="Agent">
                    <option value="">Main agent</option>
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                    <option value="gemini">Gemini</option>
                  </select>
                  <select value={m.model ?? ""} onChange={(e) => term(i, { model: e.target.value || undefined })} className={small} aria-label="Terminal model">
                    <option value="">Kind's model</option>
                    {["opus", "sonnet", "haiku"].map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1" title="It starts in plan mode, its plan on a card beside it, and works once you've approved it">
                    <input type="checkbox" checked={m.planFirst} onChange={(e) => term(i, { planFirst: e.target.checked })} />
                    plans first
                  </label>
                  {CARDS.map((c) => (
                    <label key={c} className="flex items-center gap-1 text-muted">
                      <input type="checkbox" checked={m.cards.includes(c)} onChange={(e) => term(i, { cards: e.target.checked ? [...m.cards, c] : m.cards.filter((x) => x !== c) })} />
                      {c}
                    </label>
                  ))}
                  <span className="ml-auto flex gap-1">
                    {i > 0 && (
                      <button type="button" className="text-muted hover:text-ink" onClick={() => set({ terms: [t.terms[i], ...t.terms.filter((_, j) => j !== i)] })} title="Make it the main one">
                        make main
                      </button>
                    )}
                    {t.terms.length > 1 && (
                      <button type="button" className="text-muted hover:text-red" onClick={() => set({ terms: t.terms.filter((_, j) => j !== i), lines: t.lines.filter((l) => l.from !== m.id && l.to !== m.id) })} aria-label={`Remove ${m.name}`}>
                        ×
                      </button>
                    )}
                  </span>
                </div>
                <textarea value={m.prompt} onChange={(e) => term(i, { prompt: e.target.value })} rows={1} className={`${inputClass} w-full h-auto py-1 text-[12px]`} aria-label="Terminal prompt" placeholder={i === 0 ? "Its first prompt; empty takes the kind's own" : "Its first prompt; empty, it waits for what comes along its lines"} />
              </div>
            ))}
            {t.terms.length < 6 && (
              <Button size="sm" variant="ghost" onClick={() => set({ terms: [...t.terms, { id: newId(), name: "", prompt: "", planFirst: false, cards: [] }] })}>
                Add a terminal
              </Button>
            )}
          </div>
          <div className="space-y-1.5" aria-label="Its lines">
            {t.lines.map((l, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5" data-line={i}>
                <select value={l.from} onChange={(e) => line(i, { from: e.target.value })} className={small} aria-label="From">
                  {t.terms.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => line(i, { both: !l.both })} className="px-1 text-muted hover:text-ink" title={l.both ? "Both ways: click for one way" : "One way: click for both ways"} aria-label="Which way">
                  {l.both ? "↔" : "→"}
                </button>
                <select value={l.to} onChange={(e) => line(i, { to: e.target.value })} className={small} aria-label="To">
                  {t.terms.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id}
                    </option>
                  ))}
                </select>
                <select value={l.role} onChange={(e) => line(i, { role: e.target.value as KitLine["role"] })} className={small} aria-label="What the other does">
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <select value={l.when ?? ""} onChange={(e) => line(i, { when: (e.target.value || undefined) as KitLine["when"] })} className={small} aria-label="Which turns">
                  <option value="">every turn</option>
                  <option value="passing">once checks pass</option>
                  <option value="failing">while something fails</option>
                </select>
                <input type="number" min={1} max={30} value={l.limit} onChange={(e) => line(i, { limit: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })} className={`${small} w-14`} aria-label="Hops" title="How many times it passes on before it stops for you" />
                <span className="text-faint">hops</span>
                <button type="button" className="ml-auto text-muted hover:text-red" onClick={() => set({ lines: t.lines.filter((_, j) => j !== i) })} aria-label="Remove this line">
                  ×
                </button>
                {l.role === "custom" && <input value={l.prompt ?? ""} onChange={(e) => line(i, { prompt: e.target.value })} className={`${small} w-full`} aria-label="Line prompt" placeholder="What the other end does with it" />}
              </div>
            ))}
            {t.terms.length > 1 && (
              <Button size="sm" variant="ghost" onClick={() => set({ lines: [...t.lines, { from: t.terms[0].id, to: t.terms[1].id, role: "review", both: false, limit: 4 }] })}>
                Add a line
              </Button>
            )}
          </div>
          {team && (
            <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
              Back to the usual pair
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
