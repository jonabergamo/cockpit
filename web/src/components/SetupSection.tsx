import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Requirement, SettingSpec, SettingValue } from "@cockpit/shared";
import { api } from "../lib/api";
import { useJobs } from "../lib/queries";
import { JobLog } from "./JobLog";
import { Button, copy, ErrorNote, inputClass, Loading, Tag } from "./ui";

interface SetupItem {
  source: string;
  sourceName: string;
  req: Requirement;
  found: boolean;
  version?: string;
  authed?: boolean;
  install?: string;
  canInstall: boolean;
  tokens: { spec: SettingSpec; value?: SettingValue }[];
}
interface SkillItem {
  source: string;
  sourceName: string;
  name: string;
  required: boolean;
  description?: string;
  shipped: boolean;
  state: "installed" | "differs" | "missing";
}
interface SetupRes {
  platform: string;
  items: SetupItem[];
  skills: SkillItem[];
  missing: number;
}

function SkillRow({ s }: { s: SkillItem }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const install = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.post(`/setup/${s.source}/skills/${s.name}`);
      await Promise.all(["setup", "claude-files"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="py-2.5 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`size-2 rounded-full shrink-0 ${s.state === "installed" ? "bg-green" : s.required && s.state === "missing" ? "bg-amber" : "bg-line"}`} />
        <span className="font-medium font-mono text-[13px]">{s.name}</span>
        <span className="text-[12px] text-faint">{s.source === "core" ? "cockpit" : s.sourceName}</span>
        {s.required ? <Tag tone="cobalt">needed</Tag> : <Tag>optional</Tag>}
        <span className="flex-1" />
        {s.state === "installed" && <Tag tone="green">installed</Tag>}
        {s.state === "differs" && <Tag tone="amber" title="Your copy isn't the same as the one that ships">changed</Tag>}
        {s.state === "missing" && <Tag tone={s.required ? "amber" : "plain"}>not installed</Tag>}
        {s.shipped && s.state !== "installed" && (
          <Button size="sm" variant={s.state === "missing" ? "primary" : "default"} disabled={busy} onClick={install} title={s.state === "differs" ? "Replaces your copy with the shipped one; yours is backed up first" : undefined}>
            {busy ? "Installing" : s.state === "differs" ? "Update" : "Install"}
          </Button>
        )}
      </div>
      {s.description && <div className="text-[12px] text-muted ml-4 line-clamp-2">{s.description}</div>}
      {!s.shipped && s.state === "missing" && <div className="text-[12px] text-faint ml-4">Doesn't ship with the plugin. Add it to ~/.claude/skills yourself.</div>}
      <ErrorNote error={err} />
    </div>
  );
}

// checked again every time it's shown, since installs and logins happen outside the app
export const useSetup = () => useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupRes>("/setup"), staleTime: 0, refetchOnMount: "always" });

function TokenField({ item, spec, value }: { item: SetupItem; spec: SettingSpec; value?: SettingValue }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<unknown>();
  const set = typeof value === "string" && !!value;
  const save = async (v: string | null) => {
    setErr(undefined);
    try {
      await api.put(`/plugins/${item.source}`, { settings: { [spec.key]: v } });
      setDraft("");
      await Promise.all(["setup", "plugins", "config"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="text-[13px]">
      <div className="flex items-center gap-2">
        <span className="text-muted w-28 shrink-0">{spec.label}</span>
        <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={set ? `${value} saved` : "Not set"} autoComplete="off" className={`${inputClass} flex-1 min-w-0 h-7`} />
        <Button size="sm" disabled={!draft} onClick={() => save(draft)}>
          {set ? "Replace" : "Save"}
        </Button>
        {set && (
          <Button size="sm" variant="ghost" onClick={() => save(null)}>
            Remove
          </Button>
        )}
      </div>
      {spec.help && <div className="text-[12px] text-faint mt-1 ml-[120px]">{spec.help}</div>}
      <ErrorNote error={err} />
    </div>
  );
}

function Row({ item, onJob }: { item: SetupItem; onJob: (id: string) => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [err, setErr] = useState<unknown>();
  const [copied, setCopied] = useState(false);
  const r = item.req;
  const base = `/setup/${item.source}/${r.id}`;
  const ok = item.found && item.authed !== false;

  const run = async (what: "install" | "login") => {
    setErr(undefined);
    try {
      const res = await api.post<{ id: string }>(`${base}/${what}`);
      if (what === "install") {
        await qc.invalidateQueries({ queryKey: ["jobs"] });
        onJob(res.id);
      } else navigate({ to: "/terminals", search: { id: res.id } });
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <div className="py-2.5 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`size-2 rounded-full shrink-0 ${ok ? "bg-green" : r.optional ? "bg-line" : "bg-amber"}`} />
        <span className="font-medium">{r.name}</span>
        <span className="text-[12px] text-faint">{item.source === "core" ? "cockpit" : item.sourceName}</span>
        {r.optional && <Tag>optional</Tag>}
        <span className="flex-1" />
        {item.found ? <Tag tone="green" title={item.version}>found</Tag> : <Tag tone={r.optional ? "plain" : "amber"}>missing</Tag>}
        {item.found && item.authed === true && <Tag tone="green">logged in</Tag>}
        {item.found && item.authed === false && <Tag tone="amber">not logged in</Tag>}
      </div>
      {item.version && <div className="text-[12px] text-muted ml-4 truncate">{item.version}</div>}
      <div className="flex items-center gap-2 flex-wrap ml-4">
        {!item.found && item.canInstall && (
          <Button size="sm" variant="primary" onClick={() => run("install")}>
            Install
          </Button>
        )}
        {!item.found && item.install && !item.canInstall && (
          <span className="flex items-center gap-2 text-[12px] min-w-0">
            <code className="bg-ground rounded px-1.5 py-0.5 truncate">{item.install}</code>
            <button
              className="text-cobalt hover:underline shrink-0"
              onClick={() => {
                copy(item.install!);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        )}
        {item.found && item.authed !== true && r.login && (
          <Button size="sm" variant={item.authed === false ? "primary" : "default"} onClick={() => run("login")} title={r.login.join(" ")}>
            {r.id === "claude" ? "Open Claude to /login" : "Log in"}
          </Button>
        )}
        {r.docs && (
          <a href={r.docs} target="_blank" rel="noreferrer" className="text-[12px] text-cobalt hover:underline">
            Docs
          </a>
        )}
      </div>
      {!!item.tokens.length && (
        <div className="ml-4 space-y-1.5">
          <div className="text-[12px] text-faint">Or use a token instead of logging in:</div>
          {item.tokens.map((t) => (
            <TokenField key={t.spec.key} item={item} spec={t.spec} value={t.value} />
          ))}
        </div>
      )}
      <ErrorNote error={err} />
    </div>
  );
}

// Every tool and login cockpit and its plugins need, with what's missing first.
export function SetupSection() {
  const q = useSetup();
  const jobs = useJobs();
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string>();
  const job = jobs.data?.find((j) => j.id === jobId);
  const items = [...(q.data?.items ?? [])].sort((a, b) => Number(a.found && a.authed !== false) - Number(b.found && b.authed !== false));

  return (
    <section id="setup" className="bg-panel border border-line rounded-lg p-4 space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h2 className="font-semibold">Setup</h2>
          <p className="text-[13px] text-muted mt-0.5">
            What cockpit and the plugins you turned on need on this machine. Installs run here only when they need no sudo or package manager; the rest show the command to copy.
          </p>
        </div>
        <Button size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? "Checking" : "Check again"}
        </Button>
      </div>
      {q.isLoading && <Loading what="Checking tools" />}
      <ErrorNote error={q.error} />
      {job && <JobLog job={job} onDone={() => qc.invalidateQueries({ queryKey: ["setup"] })} />}
      <div className="divide-y divide-line">
        {items.map((i) => (
          <Row key={`${i.source}/${i.req.id}`} item={i} onJob={setJobId} />
        ))}
      </div>
      {!!q.data?.skills.length && (
        <>
          <h3 className="font-medium text-[13px] text-muted pt-3">Claude Code skills</h3>
          <div className="divide-y divide-line">
            {[...q.data.skills]
              .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name))
              .map((s) => (
                <SkillRow key={`${s.source}/${s.name}`} s={s} />
              ))}
          </div>
        </>
      )}
    </section>
  );
}

// On Today, when something required is missing or logged out
export function SetupBanner() {
  const q = useSetup();
  if (!q.data?.missing) return null;
  return (
    <Link to="/settings" search={{ tab: "setup" }} className="block bg-amber-soft text-ink rounded-lg px-4 py-2.5 text-[13px] hover:brightness-105">
      {q.data.missing === 1 ? "One thing cockpit needs isn't set up yet." : `${q.data.missing} things cockpit needs aren't set up yet.`} <span className="text-cobalt">Open Setup</span>
    </Link>
  );
}
