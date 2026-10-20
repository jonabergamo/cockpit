import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FileTree } from "../components/FileTree";
import { GitHistory } from "../components/GitHistory";
import { Terminal } from "../components/Terminal";
import { useRecentFolders } from "../components/TerminalLauncher";
import { Button, Empty, ErrorNote } from "../components/ui";
import { api } from "../lib/api";
import { useLiveSessions } from "../lib/live";
import { launch, launcher, useLauncher } from "../lib/launcher";
import { useOpenSession } from "../lib/openSession";
import { termPrefs, useCopyOnSelect } from "../lib/termPrefs";
import { ago, shortPath } from "../lib/format";

export interface TermInfo {
  id: string;
  title: string;
  cwd: string;
  command: string;
  createdAt: number;
  exited?: number;
  pid?: number;
  session?: string;
  parent?: string;
}

// kept current by the `terms` push, see main.tsx
export const useTerms = () => useQuery({ queryKey: ["terms"], queryFn: () => api.get<TermInfo[]>("/code/terms") });

export function TerminalsPage() {
  const { id, resume, pid } = useSearch({ from: "/terminals" });
  const navigate = useNavigate();
  const openSession = useOpenSession();
  const [resumeErr, setResumeErr] = useState<unknown>();

  // /terminals?resume=<session> comes from the desktop app's menu bar
  useEffect(() => {
    if (resume) openSession({ id: resume, pid }).catch(setResumeErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume]);
  const qc = useQueryClient();
  const terms = useTerms();
  // split shells belong to the terminal they were opened from and only show next to it, not as tabs
  const all = terms.data ?? [];
  const tabs = all.filter((t) => !t.parent || !all.some((p) => p.id === t.parent));
  const active = id ?? tabs[0]?.id;
  const [showChanges, setShowChanges] = useState(() => {
    try {
      return localStorage.getItem(SIDE) !== "0";
    } catch {
      return true;
    }
  });
  const live = useLiveSessions();
  const copyOnSelect = useCopyOnSelect();
  const [showSplit, setShowSplitState] = useState(() => {
    try {
      return localStorage.getItem(SPLIT) !== "0";
    } catch {
      return true;
    }
  });
  const setShowSplit = (on: boolean) => {
    setShowSplitState(on);
    try {
      localStorage.setItem(SPLIT, on ? "1" : "0");
    } catch {}
  };
  const shown = all.filter((t) => t.parent === active).slice(0, 2);
  const split = showSplit && shown.length > 0;
  const [splitErr, setSplitErr] = useState<unknown>();
  // a new shell in the active terminal's folder, under it
  const addPane = async () => {
    const cur = all.find((t) => t.id === active);
    if (!cur) return;
    setSplitErr(undefined);
    setShowSplit(true);
    try {
      await api.post<TermInfo>("/code/terms", { cwd: cur.cwd, parent: cur.id, title: `shell · ${shortPath(cur.cwd).split("/").pop()}` });
      await qc.invalidateQueries({ queryKey: ["terms"] });
    } catch (e) {
      setSplitErr(e);
    }
  };
  const sessionOf = (t: TermInfo) => live.find((s) => s.id === t.session || (!!t.pid && s.pid === t.pid));

  const toggleChanges = (on: boolean) => {
    setShowChanges(on);
    try {
      localStorage.setItem(SIDE, on ? "1" : "0");
    } catch {}
  };

  // the server already dropped it; move to a neighbour tab
  const ended = async (tid: string) => {
    const list = tabs;
    const i = list.findIndex((t) => t.id === tid);
    const next = list.filter((t) => t.id !== tid)[Math.max(0, i - 1)]?.id;
    qc.setQueryData<TermInfo[]>(["terms"], (old) => old?.filter((t) => t.id !== tid));
    navigate({ to: "/terminals", search: { id: next }, replace: true });
    await qc.invalidateQueries({ queryKey: ["terms"] });
  };

  const close = async (tid: string) => {
    await api.del(`/code/terms/${tid}`);
    await qc.invalidateQueries({ queryKey: ["terms"] });
    if (tid === active) navigate({ to: "/terminals", search: { id: undefined } });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center h-11 border-b border-line bg-panel shrink-0">
        <QuickClaude />
        <div className="flex items-center gap-1 px-2 h-full overflow-x-auto min-w-0 flex-1">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`group flex items-center gap-2 h-8 pl-3 pr-1 rounded-md shrink-0 cursor-pointer ${t.id === active ? "bg-raised border border-line" : "text-muted hover:text-ink"}`}
            onClick={() => navigate({ to: "/terminals", search: { id: t.id } })}
            title={`${t.command}\n${t.cwd}\nstarted ${ago(t.createdAt)}`}
          >
            {(() => {
              // what Claude is doing in it: working, or waiting for you
              const st = sessionOf(t)?.status;
              return (
                <span
                  className={`size-1.5 rounded-full ${st === "busy" ? "bg-cobalt animate-pulse" : st === "idle" ? "bg-amber" : t.exited === undefined ? "bg-green" : "bg-line"}`}
                  title={st === "busy" ? "Claude is working" : st === "idle" ? "Claude is waiting for you" : undefined}
                />
              );
            })()}
            <span className="text-[13px] max-w-[220px] truncate">{t.title}</span>
            <span className="text-[12px] text-faint max-w-[140px] truncate">{shortPath(t.cwd).split("/").slice(-2).join("/")}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                close(t.id);
              }}
              className="size-6 rounded text-faint hover:text-red hover:bg-red-soft"
              aria-label="Close terminal"
            >
              ×
            </button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={launcher.open} className="shrink-0">
          New terminal
        </Button>
        </div>
        <div className="hidden md:flex items-center gap-1 px-2 h-full border-l border-line shrink-0">
          <Button size="sm" variant={split ? "default" : "ghost"} onClick={() => (split ? setShowSplit(false) : shown.length ? setShowSplit(true) : addPane())} title={split ? "Hide the shells, they keep running" : "A shell in the same folder, side by side"}>
            Split
          </Button>
          <Button size="sm" variant={copyOnSelect ? "default" : "ghost"} onClick={() => termPrefs.setCopyOnSelect(!copyOnSelect)} title="Copy text as soon as you select it">
            Copy on select
          </Button>
        </div>
      </div>
      <ErrorNote error={resumeErr} />
      <ErrorNote error={splitErr} />
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">{active ? <Terminal key={active} id={active} onExit={() => ended(active)} /> : <Empty>No terminals open. Start one in a worktree or from a session.</Empty>}</div>
        {split && active && window.innerWidth >= 768 && (
          <div className="flex-1 min-w-0 flex flex-col border-l border-line">
            {shown.map((p, i) => (
              <div key={p.id} className={`flex-1 min-h-0 flex flex-col ${i ? "border-t border-line" : ""}`}>
                <div className="flex items-center gap-2 h-8 px-2 border-b border-line bg-panel shrink-0">
                  <span className={`size-1.5 rounded-full ${p.exited === undefined ? "bg-green" : "bg-line"}`} />
                  <span className="flex-1 min-w-0 truncate text-[12px] text-muted" title={p.cwd}>
                    {p.title}
                  </span>
                {shown.length < 2 && (
                    <button onClick={addPane} className="px-1.5 h-6 rounded text-[12px] text-muted hover:text-ink hover:bg-ground" title="Another shell in the same folder, below this one">
                      + shell
                    </button>
                  )}
                  <button onClick={() => close(p.id)} className="size-6 rounded text-faint hover:text-red hover:bg-red-soft" aria-label="Close this shell">
                    ×
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <Terminal key={p.id} id={p.id} onExit={() => qc.invalidateQueries({ queryKey: ["terms"] })} />
                </div>
              </div>
            ))}
          </div>
        )}
        {active && !split && (showChanges ? <ChangesSide id={active} onHide={() => toggleChanges(false)} /> : (
          <button onClick={() => toggleChanges(true)} className="hidden md:block w-7 shrink-0 border-l border-line bg-panel text-[12px] text-muted hover:text-ink [writing-mode:vertical-rl] py-3" title="Show the changed files">
            Changes
          </button>
        ))}
      </div>
    </div>
  );
}

const SIDE = "cockpit.terminalChanges";
const SPLIT = "cockpit.terminalSplitShown";
const HISTORY = "cockpit.terminalHistoryShown";

interface TermChanges {
  root: string | null;
  cwd: string | null;
  changes: { path: string; index: string; work: string }[];
}

// The git changes of whatever repo the terminal is sitting in. Clicking a file opens its diff in Code.
function ChangesSide({ id, onHide }: { id: string; onHide: () => void }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["term-changes", id], queryFn: () => api.get<TermChanges>(`/code/terms/${id}/changes`), refetchInterval: 4000 });
  const d = q.data;
  const changed = new Map((d?.changes ?? []).map((c) => [c.path, (c.index + c.work).trim().replace("??", "U")]));
  const open = (file?: string) => d?.root && navigate({ to: "/code", search: { root: d.root, file, diff: file ? true : undefined } });
  const [history, setHistory] = useState(() => {
    try {
      return localStorage.getItem(HISTORY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleHistory = (on: boolean) => {
    setHistory(on);
    try {
      localStorage.setItem(HISTORY, on ? "1" : "0");
    } catch {}
  };

  return (
    <aside className="hidden md:flex w-[300px] shrink-0 border-l border-line bg-panel flex-col min-h-0">
      <div className="flex items-center gap-1 px-3 h-9 border-b border-line shrink-0">
        <span className="font-medium text-[13px] flex-1 truncate">
          Changes{d?.changes.length ? ` ${d.changes.length}` : ""}
          {d?.root && <span className="text-muted font-normal"> · {shortPath(d.root).split("/").pop()}</span>}
        </span>
        {d?.root && (
          <button onClick={() => open()} className="text-[12px] text-cobalt px-1.5 h-6 rounded hover:bg-ground" title={`Open ${d.root} in Code`}>
            Code
          </button>
        )}
        <button onClick={onHide} className="size-6 rounded text-faint hover:text-ink hover:bg-ground" aria-label="Hide the changes">
          ›
        </button>
      </div>
      <div className={`${history ? "max-h-[45%] shrink-0" : "flex-1"} min-h-0 overflow-y-auto py-1`}>
        {q.isLoading ? (
          <div className="px-3 py-2 text-[13px] text-muted">Reading git</div>
        ) : !d?.root ? (
          <div className="px-3 py-2 text-[13px] text-muted">{d?.cwd ? `${shortPath(d.cwd)} isn't in a worktree or project cockpit knows.` : "This terminal has ended."}</div>
        ) : d.changes.length ? (
          <FileTree paths={d.changes.map((c) => c.path)} changed={changed} onOpen={(p) => open(p)} expanded />
        ) : (
          <div className="px-3 py-2 text-[13px] text-muted">No uncommitted changes.</div>
        )}
      </div>
      {d?.root && (
        <>
          <button onClick={() => toggleHistory(!history)} className="flex items-center gap-1.5 px-3 h-8 border-y border-line shrink-0 text-left hover:bg-ground">
            <span className={`text-faint text-[10px] transition-transform ${history ? "rotate-90" : ""}`}>▶</span>
            <span className="font-medium text-[13px] flex-1">History</span>
          </button>
          {history && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <GitHistory root={d.root} />
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function QuickClaude() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { folders, label, ready } = useRecentFolders();
  const { last } = useLauncher();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const target = last && (folders.includes(last) || !ready) ? last : folders[0];

  const start = async (cwd: string) => {
    setBusy(true);
    setErr(undefined);
    try {
      const id = await launch(qc, cwd, "resume", label(cwd));
      navigate({ to: "/terminals", search: { id } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex items-center pl-3 pr-2 h-full border-r border-line shrink-0">
      <div className="flex">
        <Button size="sm" variant="primary" disabled={!target || busy} onClick={() => target && start(target)} className="rounded-r-none" title={target ? `Pick a session to resume in ${target}` : undefined}>
          {busy ? "Starting" : "Resume"}
          {target && <span className="hidden sm:inline font-normal opacity-80 max-w-[140px] truncate">in {label(target)}</span>}
        </Button>
        <Button size="sm" variant="primary" onClick={launcher.open} className="rounded-l-none border-l border-on-accent/25 px-1.5" aria-label="Pick a folder">
          ▾
        </Button>
      </div>
      {err && <span className="ml-2 text-[12px] text-red max-w-[220px] truncate" title={err}>{err}</span>}
    </div>
  );
}
