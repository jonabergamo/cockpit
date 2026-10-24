import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DiffReview } from "../components/DiffReview";
import { FileTree } from "../components/FileTree";
import { GitHistory } from "../components/GitHistory";
import { Terminal } from "../components/Terminal";
import { Button, Empty, ErrorNote } from "../components/ui";
import { api } from "../lib/api";
import { useLiveSessions } from "../lib/live";
import { launcher } from "../lib/launcher";
import { useOpenSession } from "../lib/openSession";
import { termPrefs, useCopyOnSelect } from "../lib/termPrefs";
import { ago, shortPath } from "../lib/format";
import { statusLook } from "../lib/status";

export type { TermInfo } from "@cockpit/shared";
import type { TermInfo } from "@cockpit/shared";

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
  // Claude's terminals first, the rest after them, each in the order they were opened
  const claude = (t: TermInfo) => !!t.session || /^claude\b/.test(t.command);
  const tabs = all.filter((t) => !t.parent || !all.some((p) => p.id === t.parent)).sort((a, b) => Number(claude(b)) - Number(claude(a)));
  // a link to a split (a run, a server) opens the terminal it sits beside, with the split showing
  const picked = all.find((t) => t.id === id);
  const inSplit = !!picked?.parent && all.some((p) => p.id === picked.parent);
  const active = inSplit ? picked!.parent : (id ?? tabs[0]?.id);
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
  // the newest three, so a run started beside two servers is the one that shows
  const beside = all.filter((t) => t.parent === active).sort((a, b) => b.createdAt - a.createdAt);
  const shown = beside.slice(0, 3);
  const split = (showSplit || inSplit) && shown.length > 0;
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

  const [closeErr, setCloseErr] = useState<unknown>();
  const close = async (tid: string) => {
    setCloseErr(undefined);
    try {
      await api.del(`/code/terms/${tid}`);
    } catch (e) {
      setCloseErr(e);
      return;
    }
    await qc.invalidateQueries({ queryKey: ["terms"] });
    if (tid === active) navigate({ to: "/terminals", search: { id: undefined } });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center h-11 border-b border-line bg-panel shrink-0">
        <div className="flex items-center pl-2 pr-1 h-full border-r border-line shrink-0">
          <button
            onClick={() => launcher.open("claude")}
            className="size-8 grid place-items-center rounded-md text-muted hover:text-ink hover:bg-ground"
            title="New terminal: Claude, resume a session or a shell, in any folder"
            aria-label="New terminal"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
          </button>
        </div>
        <div className="flex items-center gap-1 px-2 h-full overflow-x-auto min-w-0 flex-1">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`group flex items-center gap-2 h-8 pl-3 pr-1 rounded-md shrink-0 cursor-pointer ${t.id === active ? "bg-raised border border-line" : "text-muted hover:text-ink"}`}
            onClick={() => navigate({ to: "/terminals", search: { id: t.id } })}
            title={`${t.command}\n${t.node && t.node !== "local" ? `on ${t.node}: ` : ""}${t.cwd}\nstarted ${ago(t.createdAt)}${t.state === "disconnected" ? "\ndisconnected, reconnecting" : ""}`}
          >
            {t.state === "disconnected" ? (
              <span className="size-1.5 rounded-full bg-amber animate-pulse" title="Its machine is disconnected" />
            ) : (() => {
              // what Claude is doing in it: working, waiting for you, or done with its turn
              const s = sessionOf(t);
              const st = s?.status;
              const look = statusLook(st, s?.waitingFor, s?.background);
              return (
                <span
                  className={`size-1.5 rounded-full ${st === "busy" ? "bg-cobalt animate-pulse" : st === "waiting" || st === "idle" ? look.dot : t.exited === undefined ? "bg-green" : "bg-line"}`}
                  title={st && st !== "ended" ? look.hint : undefined}
                />
              );
            })()}
            {t.node && t.node !== "local" && <span className="text-[11px] px-1 rounded bg-ground text-muted">{t.node}</span>}
            <span className="text-[13px] max-w-[220px] truncate">{t.title}</span>
            <span className="text-[12px] text-faint max-w-[140px] truncate">{shortPath(t.cwd).split("/").slice(-2).join("/")}</span>
            {(() => {
              // runs and servers beside it, which show in its split
              const n = all.filter((x) => x.parent === t.id).length;
              return n ? <span className="text-[11px] text-faint" title={`${n} beside it in the split`}>+{n}</span> : null;
            })()}
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
        </div>
        <div className="hidden md:flex items-center gap-1 px-2 h-full border-l border-line shrink-0">
          <Button size="sm" variant={split ? "default" : "ghost"} onClick={() => (split ? setShowSplit(false) : shown.length ? setShowSplit(true) : addPane())} title={split ? "Hide the shells, they keep running" : "A shell in the same folder, side by side"}>
            Split{beside.length ? ` · ${beside.length}` : ""}
          </Button>
          <Button size="sm" variant={copyOnSelect ? "default" : "ghost"} onClick={() => termPrefs.setCopyOnSelect(!copyOnSelect)} title="Copy text as soon as you select it">
            Copy on select
          </Button>
        </div>
      </div>
      <ErrorNote error={resumeErr} />
      <ErrorNote error={splitErr} />
      <ErrorNote error={closeErr} />
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">{active ? <Terminal key={active} id={active} onExit={() => ended(active)} /> : <Empty>No terminals open. Start one with + above, in a worktree or from a session.</Empty>}</div>
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
  const [reviewing, setReviewing] = useState(false);
  const sessionHere = useLiveSessions().find((x) => x.term === id);
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
        {d?.root && !!d.changes.length && (
          <button onClick={() => setReviewing(true)} className="text-[12px] text-cobalt px-1.5 h-6 rounded hover:bg-ground" title="Read the diff and leave notes for Claude on specific lines">
            Review
          </button>
        )}
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
      {reviewing && d?.root && <DiffReview root={d.root} sessionId={sessionHere?.id} onClose={() => setReviewing(false)} />}
    </aside>
  );
}
