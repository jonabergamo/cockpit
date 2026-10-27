import { useAgentName, useClaudeMain } from "../lib/agent";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { type SettingsRes, useSaveSettings, useSettings } from "../lib/cost";
import { useAgents, useAppConfig } from "../lib/queries";
import { Button, ErrorNote, inputClass } from "./ui";

type Patterns = { e2e: string; audit: string; typecheck: string; lint: string; unit: string };
type S = SettingsRes["settings"] & { runs?: { patterns: Patterns; failedVideoHours?: number } };
interface HookState {
  installed: boolean;
  partly: boolean;
  command: string;
  file: string;
}

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

function Pattern({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v !== value && onSave(v);
  return (
    <label className="flex items-center gap-3 text-[13px]">
      <span className="w-24 shrink-0">{label}</span>
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} spellCheck={false} className={`${inputClass} flex-1 min-w-0 font-mono text-[12px]`} />
    </label>
  );
}

// A line of text, or a few lines, saved when you leave it
function Text({ label, help, value, lines, mono, onSave }: { label: string; help?: string; value: string; lines?: number; mono?: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v.trim() !== value && onSave(v.trim());
  const cls = `${inputClass} w-full ${mono ? "font-mono text-[12px]" : "text-[13px]"}`;
  return (
    <label className="block space-y-1 text-[13px]">
      <span className="block">{label}</span>
      {help && <span className="block text-[12px] text-faint">{help}</span>}
      {lines ? (
        <textarea value={v} rows={lines} onChange={(e) => setV(e.target.value)} onBlur={commit} className={`${cls} py-1.5 h-auto`} />
      ) : (
        <input value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} spellCheck={false} className={cls} />
      )}
    </label>
  );
}

// how a failing CI check runs here, for "Run it here" on a card
function CiLines({ lines, onSave }: { lines: string[]; onSave: (l: string[]) => void }) {
  const text = lines.join("\n");
  const [v, setV] = useState(text);
  useEffect(() => setV(text), [text]);
  const commit = () => v !== text && onSave(v.split("\n").map((l) => l.trim()).filter(Boolean));
  return (
    <div className="space-y-1.5">
      <h3 className="text-[12px] text-faint uppercase tracking-wide">CI checks here</h3>
      <p className="text-[12px] text-faint">One per line, check name = command, with * for anything in the name, like <span className="font-mono">unit-tests* = pnpm test</span>. A check with no line runs the package.json script named like its job, else repo.verifyCommand.</p>
      <textarea value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} rows={3} spellCheck={false} className={`${inputClass} w-full h-auto py-2 font-mono text-[12px]`} />
    </div>
  );
}

// The Claude Code hook that records the runs Claude does, and which commands count as which kind of run
function RunSettings({ patterns, onSave, videoHours, onVideoHours }: { patterns?: Patterns; onSave: (p: Partial<Patterns>) => void; videoHours?: number; onVideoHours: (h: number) => void }) {
  const qc = useQueryClient();
  const hook = useQuery({ queryKey: ["runs-hook"], queryFn: () => api.get<HookState>("/runs/hook") });
  const set = useMutation({ mutationFn: (on: boolean) => api.post<HookState>("/runs/hook", { on }), onSuccess: (h) => qc.setQueryData(["runs-hook"], h) });
  const h = hook.data;
  const claudeMain = useClaudeMain();
  const agent = useAgentName();
  return (
    <div className="space-y-2.5">
      <h3 className="text-[12px] text-faint uppercase tracking-wide">Runs</h3>
      {!claudeMain && (
        <p className="text-[12px] text-muted">
          {agent} has no hook like this. What it runs in cockpit's tasks shows on Runs anyway; what it runs in a terminal of yours doesn't, unless you wrap the command in <code className="font-mono">bin/cockpit run --</code>.
        </p>
      )}
      <div className="flex items-center gap-3 text-[13px]">
        <span className="flex-1 min-w-0">
          <span className="block">Record the runs Claude Code does</span>
          <span className="block text-[12px] text-faint">
            {h?.installed ? "The hook is in " : h?.partly ? "Only part of the hook is in " : "Adds a PostToolUse and PostToolUseFailure hook for Bash to "}
            {h?.file ?? "~/.claude/settings.json"}, so test, lint, typecheck, audit and E2E commands show on Runs. Your other hooks stay as they are. New sessions pick it up.
          </span>
        </span>
        {h && (h.installed || h.partly) && (
          <Button size="sm" variant="danger" onClick={() => set.mutate(false)} disabled={set.isPending}>
            Remove
          </Button>
        )}
        {h && !h.installed && (
          <Button size="sm" variant="primary" onClick={() => set.mutate(true)} disabled={set.isPending}>
            Install the hook
          </Button>
        )}
      </div>
      <ErrorNote error={hook.error ?? set.error} />
      {videoHours !== undefined && (
        <label className="flex items-center gap-3 text-[13px]">
          <span className="flex-1 min-w-0">
            <span className="block">Keep a failed run's video for</span>
            <span className="block text-[12px] text-faint">Then it's deleted, and straight away once a later run of the same thing passes. The run stays. 0 keeps them.</span>
          </span>
          <input
            type="number"
            min={0}
            max={2160}
            defaultValue={videoHours}
            onBlur={(e) => {
              const h = Math.max(0, Math.min(2160, Math.round(Number(e.target.value) || 0)));
              if (h !== videoHours) onVideoHours(h);
            }}
            className="w-20 h-8 px-2 rounded-md border border-line bg-raised text-right"
          />
          <span className="text-muted">hours</span>
        </label>
      )}
      {patterns && (
        <>
          <p className="text-[12px] text-faint">Which commands count as which kind of run, as regular expressions. They're checked from the top, with quoted text left out. Leave one empty to stop recording that kind.</p>
          <Pattern label="E2E" value={patterns.e2e} onSave={(v) => onSave({ e2e: v })} />
          <Pattern label="Audit" value={patterns.audit} onSave={(v) => onSave({ audit: v })} />
          <Pattern label="Typecheck" value={patterns.typecheck} onSave={(v) => onSave({ typecheck: v })} />
          <Pattern label="Lint" value={patterns.lint} onSave={(v) => onSave({ lint: v })} />
          <Pattern label="Tests" value={patterns.unit} onSave={(v) => onSave({ unit: v })} />
        </>
      )}
    </div>
  );
}

// What the Board does on its own: autopilot, the task queue, the repo's checks, and when to nudge you.
export function AutomationSettings() {
  const q = useSettings();
  const cfg = useAppConfig();
  const save = useSaveSettings();
  const agents = useAgents();
  const [err, setErr] = useState<unknown>();
  // runs isn't in the shared settings type yet
  const claudeMain = useClaudeMain();
  const s = q.data?.settings as S | undefined;
  if (!s) return null;
  // only Claude Code says what a session cost, so another main agent counts tokens
  const tokens = s.costs === "hide" || !claudeMain;
  const put = <K extends keyof S>(key: K, patch: Partial<NonNullable<S[K]>>) => {
    setErr(undefined);
    save({ [key]: { ...(s[key] as object), ...patch } } as Partial<SettingsRes["settings"]>).catch(setErr);
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
        <Num label="Hold new tasks above" help="Of each agent's plan limit, for its own tasks: Claude Code's 5 hour window from its status line, Codex's shortest window from its own files" value={s.tasks.pauseAbovePct} min={10} max={100} unit="% used" onSave={(n) => put("tasks", { pauseAbovePct: n })} />
        <label className="flex items-center gap-3 text-[13px]">
          <span className="flex-1">
            <span className="block">Main agent</span>
            <span className="block text-[12px] text-faint">The coding agent tasks are handed to. Using another one alongside it is up to you, in your own sessions and skills</span>
          </span>
          <select value={s.tasks.defaultAgent || "claude"} onChange={(e) => put("tasks", { defaultAgent: e.target.value === "claude" ? "" : e.target.value, defaultModel: "" })} className={inputClass}>
            {(agents.data ?? [{ id: "claude", name: "Claude Code", installed: true, enabled: true }]).filter((a) => (a.installed && a.enabled) || a.id === (s.tasks.defaultAgent || "claude")).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-3 text-[13px]">
          <span className="flex-1">Its model for tasks</span>
          <select value={s.tasks.defaultModel} onChange={(e) => put("tasks", { defaultModel: e.target.value })} className={inputClass}>
            <option value="">The agent's own default</option>
            {(agents.data?.find((a) => a.id === (s.tasks.defaultAgent || "claude"))?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <CodingAgents off={s.agents?.off ?? []} onChange={(off) => put("agents", { off })} />
      <QuickAnswers model={s.quick.model} url={s.quick.url} onSave={(patch) => put("quick", patch)} />
      <div className="space-y-2.5">
        <h3 className="text-[12px] text-faint uppercase tracking-wide">Overnight queue</h3>
        {tokens ? (
          <Num label="A night may use" help="New tokens across the night's tasks. 0 is no cap" value={s.overnight.capMTokens} min={0} max={100000} unit="M tokens" onSave={(n) => put("overnight", { capMTokens: n })} />
        ) : (
          <Num label="A night may use" help="Across the night's tasks. 0 is no cap" value={s.overnight.capUSD} min={0} max={10000} unit="dollars" onSave={(n) => put("overnight", { capUSD: n })} />
        )}
        <label className="flex items-center gap-3 text-[13px]">
          <span className="flex-1 min-w-0">
            <span className="block">Night hours</span>
            <span className="block text-[12px] text-faint">It starts by itself at the first and stops what's running at the second. Off leaves it to the button on Today</span>
          </span>
          <select value={s.overnight.fromHour} onChange={(e) => put("overnight", { fromHour: Number(e.target.value) })} className={inputClass}>
            <option value={-1}>Off</option>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                from {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </select>
          {s.overnight.fromHour >= 0 && (
            <select value={s.overnight.toHour} onChange={(e) => put("overnight", { toHour: Number(e.target.value) })} className={inputClass}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  to {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          )}
        </label>
      </div>
      <div className="space-y-2.5">
        <h3 className="text-[12px] text-faint uppercase tracking-wide">Updates</h3>
        <Toggle
          label="Update cockpit by itself"
          help="From its git remote, when no run, job or agent turn of cockpit's is going on (sessions in a terminal carry on through it), then it restarts (when it runs as a service). Its nodes update with it. Otherwise it says when there's an update, at the foot of the sidebar"
          on={s.updates.auto}
          onChange={(v) => put("updates", { auto: v })}
        />
        <div>
          <Button size="sm" onClick={() => dispatchEvent(new Event("cockpit:updates"))}>
            Check for updates
          </Button>
        </div>
      </div>
      <div className="space-y-2.5">
        <h3 className="text-[12px] text-faint uppercase tracking-wide">Ticket pipeline</h3>
        <Text label="Asking for the PR" help="Typed into a ticket's session by Ask for the PR on Work" value={s.pipeline.openPrompt} lines={2} onSave={(v) => put("pipeline", { openPrompt: v })} />
        <Text label="Answering a review" help="Typed in by Answer the review. {pr} is the PR's number" value={s.pipeline.reviewPrompt} lines={2} onSave={(v) => put("pipeline", { reviewPrompt: v })} />
        <Text label="Tickets with no code" help="A regular expression over the summary. Matching tickets with no worktree or PR go under Not code" value={s.pipeline.noCodePattern} mono onSave={(v) => put("pipeline", { noCodePattern: v })} />
        <Text label="Branches that ship" help="Comma separated. A PR into any other branch is a step of a feature, and ships when that branch's own PR does" value={s.pipeline.mainBranches} mono onSave={(v) => put("pipeline", { mainBranches: v })} />
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
        <Toggle label="Weekly digest notification" help="What shipped, what's stuck and where the tokens went, on Your week" on={s.weekly.on} onChange={(v) => put("weekly", { on: v })} />
        {s.weekly.on && (
          <label className="flex items-center gap-3 text-[13px]">
            <span className="flex-1">Send it on</span>
            <select value={s.weekly.day} onChange={(e) => put("weekly", { day: Number(e.target.value) })} className={inputClass}>
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
            <select value={s.weekly.hour} onChange={(e) => put("weekly", { hour: Number(e.target.value) })} className={inputClass}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  from {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <CiLines lines={s.ci?.local ?? []} onSave={(local) => put("ci", { local })} />
      <div className="space-y-2.5">
        <h3 className="text-[12px] text-faint uppercase tracking-wide">Budgets</h3>
        {tokens ? (
          <Num label="Budget per ticket" help="It counts new tokens across a ticket's sessions, whichever agent ran them. A ticket can set its own from its Board card. 0 is no budget" value={s.budget.perTicketMTokens} min={0} max={100000} unit="M tokens" onSave={(n) => put("budget", { perTicketMTokens: n })} />
        ) : (
          <Num label="Budget per ticket" help="Every Claude Code session on a ticket counts. A ticket can set its own from its Board card. 0 is no budget" value={s.budget.perTicketUSD} min={0} max={100000} unit="dollars" onSave={(n) => put("budget", { perTicketUSD: n })} />
        )}
        <Num label="Warn at" help="Then again when it goes over" value={s.budget.warnPct} min={10} max={100} unit="%" onSave={(n) => put("budget", { warnPct: n })} />
      </div>
      <RunSettings
        patterns={s.runs?.patterns}
        onSave={(p) => put("runs", { ...s.runs!, patterns: { ...s.runs!.patterns, ...p } })}
        videoHours={s.runs?.failedVideoHours}
        onVideoHours={(h) => put("runs", { ...s.runs!, failedVideoHours: h })}
      />
      <ErrorNote error={err} />
    </section>
  );
}

// The agents work can go to besides Claude Code's terminal, and whether each is ready on the machine that runs them
// A local model through Ollama for the short answers plugins ask for with quick, tried with the Test button
function QuickAnswers({ model, url, onSave }: { model: string; url: string; onSave: (p: { model?: string; url?: string }) => void }) {
  const [said, setSaid] = useState<string>();
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const test = async () => {
    setSaid(undefined);
    setErr(undefined);
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; output: string; ms: number }>("/claude/quick/test");
      if (r.ok) setSaid(`"${r.output}" in ${r.ms < 1000 ? `${r.ms} ms` : `${(r.ms / 1000).toFixed(1)} s`}${r.ms > 5000 ? ", most of it loading the model; it stays loaded for a while after" : ""}`);
      else setErr(new Error(r.output || "It didn't answer"));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2.5">
      <h3 className="text-[12px] text-faint uppercase tracking-wide">Quick answers</h3>
      <p className="text-[12px] text-faint">
        Short answers wanted fast, like a label or a yes or no, that plugins ask for. A small local model gives them in well under a second, free and off your plan limits. Empty leaves them to the main agent. Settings → Machines says which machine runs it.
      </p>
      <Text label="Model in Ollama" help="Like qwen2.5-coder:7b, pulled with ollama pull on the machine that runs it" value={model} mono onSave={(v) => onSave({ model: v })} />
      <Text label="Ollama's address" help="On the machine that runs it" value={url} mono onSave={(v) => onSave({ url: v || "http://127.0.0.1:11434" })} />
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={test} disabled={!model || busy}>
          {busy ? "Asking…" : "Test"}
        </Button>
        {said && <span className="text-[13px] text-green">{said}</span>}
      </div>
      <ErrorNote error={err} />
    </div>
  );
}

function CodingAgents({ off, onChange }: { off: string[]; onChange: (off: string[]) => void }) {
  const agents = useAgents();
  const [err, setErr] = useState<unknown>();
  if (!agents.data) return null;
  return (
    <div className="space-y-2.5">
      <h3 className="text-[12px] text-faint uppercase tracking-wide">Coding agents</h3>
      <p className="text-[12px] text-faint">
        Any of these can be the main agent. Besides Claude Code they run a turn at a time without a terminal: follow up from the session's page, or open it in the agent's own screen. Each needs installing and logging in on the machine the automations run on.
      </p>
      {agents.data.map((a) => (
        <div key={a.id} className="flex items-center gap-3 text-[13px]">
          <span className="flex-1 min-w-0">
            <span className="block">{a.name}</span>
            <span className="block text-[12px] text-faint truncate">{!a.enabled ? "Turned off" : a.installed ? `${a.version}${a.authed === false ? " · not logged in" : ""} · ${a.about ?? ""}` : `Not installed (${a.id} isn't on the PATH; config.local.toml's [agents.${a.id}] bin can say where it is)`}</span>
          </span>
          {a.installed && a.enabled && (
            <Button size="sm" variant={a.authed === false ? "primary" : "ghost"} onClick={() => api.post(`/agents/${a.id}/login`).then(() => (location.href = "/terminals"), setErr)}>
              Log in
            </Button>
          )}
          {a.id !== "claude" && (
            <Button size="sm" variant={off.includes(a.id) ? "default" : "ghost"} onClick={() => onChange(off.includes(a.id) ? off.filter((x) => x !== a.id) : [...off, a.id])} title={off.includes(a.id) ? "Off: left out of the pickers, and nothing is handed to it" : "Turn it off"}>
              {off.includes(a.id) ? "Turn on" : "Turn off"}
            </Button>
          )}
        </div>
      ))}
      <ErrorNote error={err} />
    </div>
  );
}
