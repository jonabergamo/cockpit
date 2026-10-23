import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { PluginInfo, SettingSpec, SettingValue } from "@cockpit/shared";
import { api } from "../lib/api";
import { useSaveSettings, useSettings } from "../lib/cost";
import { coreNav, fixedNav, screenNav, screenTabs, type NavItem } from "../lib/nav";
import { useAppConfig } from "../lib/queries";
import { shortPath } from "../lib/format";
import { Button, ErrorNote, inputClass, Tag } from "./ui";

interface PluginsRes {
  plugins: PluginInfo[];
  broken: { dir: string; error: string }[];
  dirs: { bundled: string; user: string };
}

interface Preview {
  token: string;
  manifest: PluginInfo["manifest"];
  commit: string;
  hasCode: boolean;
  uses: string[];
  asks: { settings: string[]; secrets: string[]; commands: string[]; skills: string[] };
  replaces?: { bundled: boolean; version: string; commit?: string; on: boolean };
  upToDate: boolean;
  commits?: string[];
  changes?: string[];
}

// What a plugin from a link would be and ask for, before anything of it runs
function PreviewCard({ v, onDone, onCancel }: { v: Preview; onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.post("/plugins/install", { token: v.token });
      await Promise.all([qc.invalidateQueries({ queryKey: ["plugins"] }), qc.invalidateQueries({ queryKey: ["config"] })]);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const update = !!v.replaces?.commit;
  const row = (label: string, list: string[]) =>
    list.length > 0 && (
      <div>
        <span className="text-muted">{label}:</span> {list.join(", ")}
      </div>
    );
  return (
    <div className="border border-amber/50 bg-amber-soft/30 rounded-lg p-3 space-y-2 text-[13px]">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">{v.manifest.name}</span>
        <span className="text-[12px] text-faint">
          {v.manifest.version} · {v.commit.slice(0, 7)}
          {v.manifest.author ? ` · by ${v.manifest.author}` : ""}
        </span>
        {v.replaces?.bundled && <Tag tone="amber">replaces the bundled one</Tag>}
        {update && <Tag tone="cobalt">update from {v.replaces!.commit!.slice(0, 7)}</Tag>}
      </div>
      {v.manifest.description && <p className="text-muted">{v.manifest.description}</p>}
      {v.upToDate ? (
        <p>It's already on the latest commit.</p>
      ) : (
        <>
          <p className={v.hasCode ? "text-amber" : "text-muted"}>
            {v.hasCode ? "It runs code on this machine with your user's access once it's on, so only install it if you trust where it comes from." : "Data only (themes and the like), it runs no code."}
          </p>
          <div className="space-y-0.5">
            {row("Its code", v.uses)}
            {row("Settings", v.asks.settings)}
            {row("Secrets", v.asks.secrets)}
            {row("Needs installed", v.asks.commands)}
            {row("Skills", v.asks.skills)}
            {update && row("What changed in what it asks", v.changes ?? [])}
          </div>
          {update && !!v.commits?.length && (
            <pre className="max-h-32 overflow-auto rounded-md bg-ground px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap">{v.commits.join("\n")}</pre>
          )}
          <p className="text-[12px] text-faint">{update ? (v.replaces!.on ? "It's turned off while the files change, then back on." : "It stays off.") : "It's installed off and pinned to this commit. Turn it on once you've set it up."}</p>
        </>
      )}
      <ErrorNote error={err} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {v.upToDate ? "Close" : "Cancel"}
        </Button>
        {!v.upToDate && (
          <Button size="sm" variant="primary" disabled={busy} onClick={go}>
            {busy ? "Installing" : update ? "Update it" : "Install it"}
          </Button>
        )}
      </div>
    </div>
  );
}

function InstallFromLink() {
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [ref, setRef] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [v, setV] = useState<Preview>();
  const look = async () => {
    setBusy(true);
    setErr(undefined);
    setV(undefined);
    try {
      setV(await api.post<Preview>("/plugins/install/preview", { url, path: path || undefined, ref: ref || undefined }));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) look();
        }}
      >
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Install from a git link, or owner/name on GitHub" className={`${inputClass} flex-1 min-w-[240px]`} />
        <Button disabled={busy || !url.trim()}>{busy ? "Looking" : "Look at it"}</Button>
        <button type="button" onClick={() => setMore((m) => !m)} className="text-[12px] text-muted hover:text-ink">
          {more ? "Fewer options" : "Folder or branch"}
        </button>
        {more && (
          <div className="flex flex-wrap gap-2 w-full">
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Folder in the repo, e.g. plugins/linear" className={`${inputClass} flex-1 min-w-[200px]`} />
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Branch or tag (default branch if empty)" className={`${inputClass} flex-1 min-w-[200px]`} />
          </div>
        )}
      </form>
      <ErrorNote error={err} />
      {v && (
        <PreviewCard
          v={v}
          onCancel={() => setV(undefined)}
          onDone={() => {
            setV(undefined);
            setUrl("");
          }}
        />
      )}
    </div>
  );
}

// an installed plugin's link: look for an update, or take it out
function SourceRow({ p }: { p: PluginInfo }) {
  const qc = useQueryClient();
  const [v, setV] = useState<Preview>();
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const src = p.source!;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[12px] text-faint">
        <span className="flex-1 min-w-0 truncate" title={src.url}>
          From {src.url.replace(/^https:\/\/github\.com\/|\.git$/g, "")}
          {src.path ? ` · ${src.path}` : ""}
          {src.ref ? ` · ${src.ref}` : ""} · {src.commit.slice(0, 7)}
        </span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(async () => setV(await api.post<Preview>(`/plugins/${p.manifest.id}/update/preview`)))}>
          {busy && !v ? "Looking" : "Check for an update"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            confirm(`Remove ${p.manifest.name}? Its folder is deleted; its settings stay in case you install it again.`) &&
            act(async () => {
              await api.del(`/plugins/${p.manifest.id}`);
              await qc.invalidateQueries({ queryKey: ["plugins"] });
            })
          }
        >
          Remove
        </Button>
      </div>
      <ErrorNote error={err} />
      {v && <PreviewCard v={v} onCancel={() => setV(undefined)} onDone={() => setV(undefined)} />}
    </div>
  );
}

export const usePlugins = () => useQuery({ queryKey: ["plugins"], queryFn: () => api.get<PluginsRes>("/plugins") });

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-cobalt" : "bg-line"}`}
    >
      <span className={`absolute top-0.5 size-4 rounded-full bg-raised shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

// Every screen in the sidebar, core and from plugins, with a switch to take it out of the nav and ⌘K.
export function ScreensSection() {
  const s = useSettings();
  const cfg = useAppConfig();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const [err, setErr] = useState<unknown>();
  const hidden = new Set(s.data?.settings.hidden ?? []);
  // each screen followed by the tabs that can go on their own
  const tabs = (n: NavItem): NavItem[] => (screenTabs[n.id] ?? []).filter((t) => t.id).map((t) => ({ id: t.id!, to: t.to, label: `${t.label}, a tab in ${n.label}`, key: "", needs: t.needs }));
  const items = [...coreNav.flatMap((n) => [n, ...tabs(n)]), ...(cfg.data?.screens ?? []).filter((s) => !s.settings).map(screenNav)];

  const toggle = async (id: string, show: boolean) => {
    setErr(undefined);
    const next = show ? [...hidden].filter((h) => h !== id) : [...hidden, id];
    try {
      await save({ hidden: next });
      await qc.invalidateQueries({ queryKey: ["config"] });
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div>
        <h2 className="font-semibold">Screens</h2>
        <p className="text-[13px] text-muted mt-0.5">Hide what you don't use. A hidden screen still opens from a link, it just leaves the sidebar and ⌘K. A hidden tab leaves its screen, and goes when its screen does.</p>
      </div>
      <ErrorNote error={err} />
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
        {items.map((n) => {
          // a screen that needs a tracker or code host stays out until a plugin provides one
          const missing = !!n.needs && !cfg.data?.[n.needs];
          return (
            <label key={n.id} className="flex items-center gap-2.5 text-[14px] py-0.5">
              <Switch on={!missing && (fixedNav.includes(n.id) || !hidden.has(n.id))} disabled={missing || fixedNav.includes(n.id)} onChange={(on) => toggle(n.id, on)} label={`Show ${n.label}`} />
              <span className={`flex-1 truncate ${missing ? "text-faint" : ""}`}>{n.label}</span>
              {n.plugin && <span className="text-[12px] text-faint">{n.plugin}</span>}
              {missing && <span className="text-[12px] text-faint">needs a {n.needs === "tracker" ? "tracker" : "code host"} plugin</span>}
            </label>
          );
        })}
      </div>
    </section>
  );
}

function SettingField({ spec, value, onChange }: { spec: SettingSpec; value: SettingValue | undefined; onChange: (v: string | boolean) => void }) {
  if (spec.type === "bool") return <Switch on={!!value} onChange={onChange} label={spec.label} />;
  // lists edit as one item per line, JSON as text; the server turns them back
  if (spec.type === "list" || spec.type === "json") {
    const text = typeof value === "string" ? value : spec.type === "list" ? ((value as string[] | undefined) ?? []).join("\n") : JSON.stringify(value ?? {}, null, 2);
    return <textarea value={text} onChange={(e) => onChange(e.target.value)} rows={spec.type === "list" ? 4 : 5} spellCheck={false} className={`${inputClass} w-full h-auto py-1.5 font-mono text-[12px]`} />;
  }
  if (spec.type === "choice")
    return (
      <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={`${inputClass} w-full`}>
        {spec.choices?.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    );
  return (
    <input
      type={spec.type === "secret" ? "password" : spec.type === "number" ? "number" : "text"}
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value)}
      // a masked secret is cleared on focus, so typing replaces it rather than appending
      onFocus={() => spec.type === "secret" && String(value).startsWith("••••") && onChange("")}
      placeholder={spec.type === "secret" ? "Not set" : String(spec.default ?? "")}
      autoComplete="off"
      className={`${inputClass} w-full`}
    />
  );
}

function PluginCard({ p }: { p: PluginInfo }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(p.settings);
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const log = useQuery({ queryKey: ["plugins", p.manifest.id, "log"], queryFn: () => api.get<string[]>(`/plugins/${p.manifest.id}/log`), enabled: showLog, refetchInterval: showLog ? 3000 : false });
  const specs = p.manifest.settings ?? [];
  const dirty = specs.some((s) => draft[s.key] !== p.settings[s.key]);

  const put = async (body: { on?: boolean; settings?: Record<string, unknown> }) => {
    setBusy(true);
    setErr(undefined);
    try {
      const next = await api.put<PluginInfo>(`/plugins/${p.manifest.id}`, body);
      setDraft(next.settings);
      await Promise.all([qc.invalidateQueries({ queryKey: ["plugins"] }), qc.invalidateQueries({ queryKey: ["config"] })]);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-line rounded-lg p-3 space-y-2.5">
      <div className="flex items-start gap-3">
        <Switch on={p.on} disabled={busy} onChange={(on) => put({ on })} label={`Turn ${p.manifest.name} ${p.on ? "off" : "on"}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{p.manifest.name}</span>
            <span className="text-[12px] text-faint">{p.manifest.version}</span>
            {p.bundled && <Tag>bundled</Tag>}
            {p.state === "error" && <Tag tone="red">error</Tag>}
            {p.state === "loading" && <Tag tone="amber">loading</Tag>}
            {!!p.screens.length && p.on && <Tag tone="cobalt">{p.screens.length === 1 ? "1 screen" : `${p.screens.length} screens`}</Tag>}
            {!!p.themes.length && p.on && <Tag tone="cobalt">{p.themes.length === 1 ? "1 theme" : `${p.themes.length} themes`}</Tag>}
          </div>
          {p.manifest.description && <p className="text-[13px] text-muted mt-0.5">{p.manifest.description}</p>}
          <p className="text-[12px] text-faint mt-0.5 truncate" title={p.dir}>
            {shortPath(p.dir)}
            {p.manifest.author ? ` · by ${p.manifest.author}` : ""}
            {p.hasCode ? " · runs code on this machine with your user's access" : " · data only, runs no code"}
          </p>
        </div>
        <button onClick={() => setShowLog((v) => !v)} className="text-[12px] text-muted hover:text-ink shrink-0">
          {showLog ? "Hide log" : "Log"}
        </button>
      </div>
      {p.source && <SourceRow p={p} />}
      {p.error && <pre className="text-[12px] text-red bg-red-soft rounded-md px-3 py-2 whitespace-pre-wrap max-h-40 overflow-y-auto">{p.error}</pre>}
      {showLog && <pre className="text-[12px] text-muted bg-ground rounded-md px-3 py-2 whitespace-pre-wrap max-h-48 overflow-y-auto">{log.data?.length ? log.data.join("\n") : "Nothing logged yet."}</pre>}
      {!!specs.length && (
        <div className="grid sm:grid-cols-2 gap-3 pt-1">
          {specs.map((s) => (
            <label key={s.key} className={`block text-[13px] ${s.type === "bool" ? "flex items-center gap-2.5" : ""} ${s.type === "json" ? "sm:col-span-2" : ""}`}>
              {s.type !== "bool" && <span className="block text-muted mb-1">{s.label}</span>}
              <SettingField spec={s} value={draft[s.key]} onChange={(v) => setDraft((d) => ({ ...d, [s.key]: v }))} />
              {s.type === "bool" && <span>{s.label}</span>}
              {s.help && <span className="block text-[12px] text-faint mt-1">{s.help}</span>}
            </label>
          ))}
        </div>
      )}
      <ErrorNote error={err} />
      {dirty && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(p.settings)}>
            Undo
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => put({ settings: draft })}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

export function PluginsSection() {
  const q = usePlugins();
  const d = q.data;
  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div>
        <h2 className="font-semibold">Plugins</h2>
        <p className="text-[13px] text-muted mt-0.5">
          Plugins add screens, themes and integrations. Put yours in <code className="text-[12px]">{d ? shortPath(d.dirs.user) : "the plugins folder"}</code>, one folder each, and
          they show up here, or install one from a git link below. Edits reload on their own. <code className="text-[12px]">plugins/PLUGINS.md</code> in the repo explains how to write one.
        </p>
      </div>
      <InstallFromLink />
      <ErrorNote error={q.error} />
      {d?.plugins.map((p) => <PluginCard key={p.manifest.id} p={p} />)}
      {d?.broken.map((b) => (
        <div key={b.dir} className="border border-line rounded-lg p-3">
          <div className="text-[13px] font-medium">{shortPath(b.dir)}</div>
          <pre className="text-[12px] text-red bg-red-soft rounded-md px-3 py-2 mt-2 whitespace-pre-wrap">{b.error}</pre>
        </div>
      ))}
      {d && !d.plugins.length && !d.broken.length && <p className="text-[13px] text-muted">No plugins yet.</p>}
    </section>
  );
}
