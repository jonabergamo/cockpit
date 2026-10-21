import { useEffect, useState } from "react";
import { type SettingsRes, useSaveSettings, useSettings } from "../lib/cost";
import { useAppConfig } from "../lib/queries";
import { ErrorNote, inputClass } from "./ui";

type S = SettingsRes["settings"];

function Num({ label, help, value, min, max, unit, onSave }: { label: string; help?: string; value: number; min: number; max: number; unit?: string; onSave: (n: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n >= min && n <= max && n !== value) onSave(n);
    else setV(String(value));
  };
  return (
    <label className="flex items-center gap-3 text-[13px]">
      <span className="flex-1 min-w-0">
        <span className="block">{label}</span>
        {help && <span className="block text-[12px] text-faint">{help}</span>}
      </span>
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} inputMode="numeric" className={`${inputClass} w-20 text-right tabular-nums`} />
      {unit && <span className="w-14 text-muted">{unit}</span>}
    </label>
  );
}

function Toggle({ label, help, on, onChange }: { label: string; help?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 text-[13px] cursor-pointer">
      <span className="flex-1 min-w-0">
        <span className="block">{label}</span>
        {help && <span className="block text-[12px] text-faint">{help}</span>}
      </span>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--cobalt)]" />
    </label>
  );
}

// What the Board does on its own: autopilot, the task queue, the repo's checks, and when to nudge you.
export function AutomationSettings() {
  const q = useSettings();
  const cfg = useAppConfig();
  const save = useSaveSettings();
  const [err, setErr] = useState<unknown>();
  const s = q.data?.settings;
  if (!s) return null;
  const put = <K extends keyof S>(key: K, patch: Partial<S[K]>) => {
    setErr(undefined);
    save({ [key]: { ...(s[key] as object), ...patch } } as Partial<S>).catch(setErr);
  };

  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-4">
      <div>
        <h2 className="font-semibold">Board and automation</h2>
        <p className="text-[13px] text-muted mt-0.5">How much the Board does by itself. The repo's own commands are set in config.local.toml: {cfg.data?.verify ? "repo.verifyCommand is set" : "repo.verifyCommand isn't set, so there are no local checks"}, and {cfg.data?.preview ? "repo.devCommand is set for previews" : "repo.devCommand isn't set, so there are no previews"}.</p>
      </div>
      <div className="space-y-2.5">
        <h3 className="text-[12px] text-faint uppercase tracking-wide">Task queue</h3>
        <Num label="Tasks running at once" value={s.tasks.maxParallel} min={1} max={12} onSave={(n) => put("tasks", { maxParallel: n })} />
        <Num label="Hold new tasks above" help="Of the 5 hour limit, as the status line reports it" value={s.tasks.pauseAbovePct} min={10} max={100} unit="% used" onSave={(n) => put("tasks", { pauseAbovePct: n })} />
        <label className="flex items-center gap-3 text-[13px]">
          <span className="flex-1">Default model for tasks</span>
          <select value={s.tasks.defaultModel} onChange={(e) => put("tasks", { defaultModel: e.target.value })} className={inputClass}>
            {["", "opus", "sonnet", "haiku"].map((m) => (
              <option key={m} value={m}>
                {m || "Claude Code's default"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="space-y-2.5">
        <h3 className="text-[12px] text-faint uppercase tracking-wide">Autopilot</h3>
        <Num label="Tries before it stops and asks you" value={s.autopilot.maxAttempts} min={1} max={10} onSave={(n) => put("autopilot", { maxAttempts: n })} />
        <Toggle label="On for new worktrees" help="Otherwise you turn it on per card" on={s.autopilot.onByDefault} onChange={(v) => put("autopilot", { onByDefault: v })} />
      </div>
      <div className="space-y-2.5">
        <h3 className="text-[12px] text-faint uppercase tracking-wide">Checks and alerts</h3>
        <Toggle label="Run the repo's checks when a session finishes" help="In its worktree, with repo.verifyCommand" on={s.verify.auto} onChange={(v) => put("verify", { auto: v })} />
        <Num label="Call a busy session stuck after" help="With nothing new in its transcript" value={s.alerts.stuckMinutes} min={5} max={240} unit="minutes" onSave={(n) => put("alerts", { stuckMinutes: n })} />
        <Num label="Nudge again when a session waits" help="A second, urgent notification. 0 turns it off" value={s.alerts.escalateMinutes} min={0} max={240} unit="minutes" onSave={(n) => put("alerts", { escalateMinutes: n })} />
        <Num label="Show “While you were away” after" value={s.away.minutes} min={5} max={1440} unit="minutes" onSave={(n) => put("away", { minutes: n })} />
      </div>
      <ErrorNote error={err} />
    </section>
  );
}
