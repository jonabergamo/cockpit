import { useEffect, useState } from "react";
import { type SettingsRes, useSaveSettings, useSettings } from "../lib/cost";
import { useAgents, useAppConfig } from "../lib/queries";
import { Button, ErrorNote, inputClass } from "./ui";

type Template = SettingsRes["settings"]["templates"][number];

const blank = (): Template => ({ id: Math.random().toString(36).slice(2, 10), name: "", match: "", vars: {}, agent: "", model: "", prompt: "", autopilot: "default" });
const varsText = (v: Record<string, string>) => Object.entries(v).map(([k, x]) => `${k}=${x}`).join("\n");
const parseVars = (text: string) => Object.fromEntries(text.split("\n").map((l) => l.trim()).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));

function badPattern(p: string) {
  try {
    new RegExp(p, "i");
    return false;
  } catch {
    return true;
  }
}

function Row({ t, vars, onChange, onRemove, onMove }: { t: Template; vars: string; onChange: (patch: Partial<Template>, vars?: string) => void; onRemove: () => void; onMove: (d: -1 | 1) => void }) {
  const agents = useAgents().data ?? [];
  const models = agents.find((a) => a.id === (t.agent || "claude"))?.models ?? [];
  return (
    <div className="rounded-md border border-line bg-raised p-3 space-y-2 text-[13px]">
      <div className="flex flex-wrap gap-2">
        <input value={t.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Frontend" className={`${inputClass} w-40`} aria-label="Name" />
        <input value={t.match} onChange={(e) => onChange({ match: e.target.value })} placeholder="Matches every ticket" className={`${inputClass} flex-1 min-w-[180px] font-mono text-[12px] ${badPattern(t.match) ? "border-red" : ""}`} aria-label="Pattern" title="A pattern tested against the ticket's summary and type, ignoring case. Empty matches every ticket" />
        <select value={t.agent ?? ""} onChange={(e) => onChange({ agent: e.target.value, model: "" })} className={inputClass} aria-label="Agent">
          <option value="">Default agent</option>
          {agents.filter((a) => a.installed || a.id === t.agent).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={t.model} onChange={(e) => onChange({ model: e.target.value })} className={inputClass} aria-label="Model">
          <option value="">Default model</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select value={t.autopilot} onChange={(e) => onChange({ autopilot: e.target.value as Template["autopilot"] })} className={inputClass} aria-label="Autopilot">
          <option value="default">Autopilot as set</option>
          <option value="on">Autopilot on</option>
          <option value="off">Autopilot off</option>
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <textarea value={t.prompt} onChange={(e) => onChange({ prompt: e.target.value })} rows={2} placeholder="Starting prompt. {url}, {ticket} and {summary} are the ticket's. Empty sends the ticket link" className={`${inputClass} flex-1 min-w-[240px] h-auto py-1.5`} aria-label="Starting prompt" />
        <textarea value={vars} onChange={(e) => onChange({}, e.target.value)} rows={2} placeholder={"apps=web,api"} className={`${inputClass} w-56 h-auto py-1.5 font-mono text-[12px]`} aria-label="Values for repo.createCommand" title="name=value, one per line, for {name} in repo.createCommand" />
      </div>
      <div className="flex gap-1.5 justify-end">
        <Button size="sm" variant="ghost" onClick={() => onMove(-1)} title="Checked earlier">
          Up
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onMove(1)} title="Checked later">
          Down
        </Button>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

// Kinds of work: what a ticket's worktree and Claude session start with, picked by the first pattern that matches.
export function TemplateSettings() {
  const q = useSettings();
  const cfg = useAppConfig();
  const save = useSaveSettings();
  const saved = q.data?.settings.templates;
  const [list, setList] = useState<Template[]>([]);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<unknown>();
  useEffect(() => {
    if (!saved || dirty) return;
    setList(saved);
    setVars(Object.fromEntries(saved.map((t) => [t.id, varsText(t.vars)])));
  }, [saved, dirty]);
  if (!saved) return null;

  const change = (id: string, patch: Partial<Template>, v?: string) => {
    setList((l) => l.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    if (v !== undefined) setVars((x) => ({ ...x, [id]: v }));
    setDirty(true);
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    setList(next);
    setDirty(true);
  };
  const commit = async () => {
    setErr(undefined);
    const out = list.map((t) => ({ ...t, name: t.name.trim() || "Untitled", vars: parseVars(vars[t.id] ?? "") }));
    if (out.some((t) => badPattern(t.match))) return setErr(new Error("One of the patterns isn't a valid regular expression"));
    try {
      await save({ templates: out });
      setDirty(false);
    } catch (e) {
      setErr(e);
    }
  };
  const placeholders = cfg.data?.createVars ?? [];

  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div>
        <h2 className="font-semibold">Kinds of work</h2>
        <p className="text-[13px] text-muted mt-0.5">
          What a ticket's worktree and Claude session start with: its model, its first prompt, autopilot, and values for repo.createCommand. The first pattern that matches the ticket's summary or type wins, so put one with no pattern last as the default.
          {placeholders.length > 0 && ` Your createCommand uses ${placeholders.map((p) => `{${p}}`).join(", ")}, so every kind of work should set ${placeholders.length === 1 ? "it" : "them"}.`}
        </p>
      </div>
      {list.map((t, i) => (
        <Row key={t.id} t={t} vars={vars[t.id] ?? ""} onChange={(p, v) => change(t.id, p, v)} onRemove={() => (setList(list.filter((x) => x.id !== t.id)), setDirty(true))} onMove={(d) => move(i, d)} />
      ))}
      {!list.length && <p className="text-[13px] text-faint">None yet. Every ticket starts the same way, with its link as the prompt.</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => (setList([...list, blank()]), setDirty(true))}>
          Add a kind of work
        </Button>
        {dirty && (
          <>
            <Button size="sm" variant="primary" onClick={commit}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDirty(false)}>
              Discard changes
            </Button>
          </>
        )}
      </div>
      <ErrorNote error={err} />
    </section>
  );
}
