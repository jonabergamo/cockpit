import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { RunKind, RunOptionList, RunOptionStarted, Worktree } from "@cockpit/shared";
import { api } from "../lib/api";
import { shortPath } from "../lib/format";
import { group, item } from "./CommandPalette";
import { Spinner, Tag } from "./ui";

// Opened from the Runs screen and ⌘K, so the open state lives outside both. worktree or ticket picks the worktree
// to start on, the way the Runs list is filtered.
let state: { open: boolean; worktree?: string; ticket?: string } = { open: false };
const listeners = new Set<() => void>();
const set = (s: typeof state) => {
  state = s;
  listeners.forEach((l) => l());
};
export const runSomething = { open: (prefill: { worktree?: string; ticket?: string } = {}) => set({ open: true, ...prefill }), close: () => set({ open: false }) };
const useRunSomething = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => state,
  );

const LAST = "cockpit.runSomething.worktree";
const readLast = () => {
  try {
    return localStorage.getItem(LAST) ?? undefined;
  } catch {
    return undefined;
  }
};
const writeLast = (v: string) => {
  try {
    localStorage.setItem(LAST, v);
  } catch {}
};

const KINDS: { value: RunKind | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "unit", label: "Unit" },
  { value: "lint", label: "Lint" },
  { value: "typecheck", label: "Typecheck" },
  { value: "audit", label: "Audit" },
  { value: "e2e", label: "E2E" },
  { value: "ci", label: "CI" },
  { value: "verify", label: "Verify" },
  { value: "other", label: "Other" },
];
const kindLabel = (k: RunKind) => KINDS.find((x) => x.value === k)?.label ?? k;
const chip = (on: boolean) => `px-2 h-6 rounded text-[12px] font-medium whitespace-nowrap ${on ? "bg-raised text-ink shadow-[0_0_0_1px_var(--line)]" : "text-muted hover:text-ink"}`;

// Pick a worktree (or the main checkout), then something to run in it: its verify command, a package.json script,
// or what a plugin offers. It starts as a run, in a terminal beside the worktree's Claude when it has one.
export function RunSomething() {
  const s = useRunSomething();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const worktrees = useQuery({ queryKey: ["worktrees"], queryFn: () => api.get<Worktree[]>("/worktrees"), enabled: s.open });
  const [picked, setPicked] = useState<string>();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<RunKind | "">("");
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [note, setNote] = useState<{ text: string; link?: string }>();
  const [looking, setLooking] = useState(false);
  const optionsUrl = (force = false) => `/runs/options?worktree=${encodeURIComponent(picked!)}${force ? "&force=1" : ""}`;
  const options = useQuery({
    queryKey: ["run-options", picked],
    queryFn: () => api.get<RunOptionList>(optionsUrl()),
    enabled: s.open && !!picked,
    // the server keeps the list 30 seconds too
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!s.open) return;
    setSearch("");
    setKind("");
    setErr(undefined);
    setNote(undefined);
    setPicked(s.worktree);
  }, [s.open, s.worktree]);
  // a ticket filter only says which worktree once the list is in
  useEffect(() => {
    if (s.open && !s.worktree && s.ticket && worktrees.data) setPicked((p) => p ?? worktrees.data.find((w) => !w.main && w.ticket === s.ticket)?.path);
  }, [s.open, s.worktree, s.ticket, worktrees.data]);

  if (!s.open) return null;

  const wt = worktrees.data?.find((w) => w.path === picked);
  const wtName = (w?: Worktree) => (w ? (w.main ? `${w.name} (main checkout)` : w.name) : picked ? shortPath(picked) : "");
  const pick = (path: string) => {
    writeLast(path);
    setPicked(path);
    setSearch("");
    setKind("");
    setErr(undefined);
    setNote(undefined);
  };
  const back = () => {
    setPicked(undefined);
    setSearch("");
    setErr(undefined);
    setNote(undefined);
  };

  // past the server's 30 seconds too, say after adding a script
  const lookAgain = async () => {
    setLooking(true);
    setErr(undefined);
    try {
      qc.setQueryData(["run-options", picked], await api.get<RunOptionList>(optionsUrl(true)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLooking(false);
    }
  };

  const start = async (id: string) => {
    if (!picked || busy) return;
    setBusy(id);
    setErr(undefined);
    setNote(undefined);
    try {
      const r = await api.post<RunOptionStarted>("/runs/options/start", { worktree: picked, id });
      await Promise.all([qc.invalidateQueries({ queryKey: ["runs"] }), qc.invalidateQueries({ queryKey: ["terms"] })]);
      if (r.runId) {
        runSomething.close();
        navigate({ to: "/runs/$id", params: { id: r.runId } });
      } else if (r.term) {
        runSomething.close();
        navigate({ to: "/terminals", search: { id: r.term } });
      } else setNote({ text: r.note || "Started.", link: r.link });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  // the last one you ran something in comes first, so Enter picks it again
  const last = readLast();
  const list = [...(worktrees.data ?? [])].sort((a, b) => Number(b.path === last) - Number(a.path === last) || Number(b.main) - Number(a.main));
  const all = options.data?.options ?? [];
  const shown = kind ? all.filter((o) => o.kind === kind) : all;
  const groups = [...new Set(shown.map((o) => o.group))];
  const count = (k: RunKind | "") => (k ? all.filter((o) => o.kind === k).length : all.length);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4" onClick={() => runSomething.close()}>
      <div className="absolute inset-0 bg-black/30" />
      <Command
        key={picked ? "options" : "worktrees"}
        label="Run something"
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl bg-panel border border-line rounded-lg shadow-xl overflow-hidden"
        onKeyDown={(e) => {
          if (e.key === "Escape") runSomething.close();
          if (picked && e.key === "Backspace" && !search) back();
          if (picked && e.key === "Tab") {
            e.preventDefault();
            const i = KINDS.findIndex((k) => k.value === kind);
            setKind(KINDS[(i + (e.shiftKey ? KINDS.length - 1 : 1)) % KINDS.length].value);
          }
        }}
      >
        <div className="flex items-center gap-2 px-3 pt-3 min-w-0">
          {picked ? (
            <>
              <button onClick={back} className="text-[13px] text-muted hover:text-ink shrink-0">
                ← Worktrees
              </button>
              <span className="font-medium truncate shrink-0 max-w-[55%]">{wtName(wt)}</span>
              {wt?.branch && <span className="text-[12px] text-muted truncate">{wt.branch}</span>}
            </>
          ) : (
            <span className="font-medium">Run something</span>
          )}
          <span className="ml-auto text-[12px] text-faint shrink-0">{busy ? "Starting" : picked ? "Tab switches kind · ⏎ runs" : "⏎ picks"}</span>
        </div>
        {picked && (
          <div className="flex items-center gap-0.5 px-3 pt-2 overflow-x-auto">
            {KINDS.map((k) => (
              <button key={k.value} onClick={() => setKind(k.value)} className={chip(kind === k.value)}>
                {k.label}
                {options.data && <span className="text-faint ml-1 tabular-nums">{count(k.value)}</span>}
              </button>
            ))}
          </div>
        )}
        <Command.Input
          value={search}
          onValueChange={setSearch}
          autoFocus
          placeholder={picked ? "Script, check or flow" : "Worktree name, branch or ticket"}
          className="w-full h-12 px-4 bg-transparent border-b border-line outline-none"
        />
        {err && <div className="px-4 py-2 text-[13px] text-red bg-red-soft border-b border-line">{err}</div>}
        {note && (
          <div className="px-4 py-2 text-[13px] border-b border-line flex items-center gap-3">
            <span className="flex-1">{note.text}</span>
            {note.link && (
              <button
                onClick={() => {
                  runSomething.close();
                  router.history.push(note.link!);
                }}
                className="text-cobalt hover:underline shrink-0"
              >
                Follow it
              </button>
            )}
          </div>
        )}
        {picked && options.data?.errors.map((e) => (
          <div key={e.source} className="px-4 py-1.5 text-[12px] text-amber border-b border-line">
            {e.source} couldn't say what it can run: {e.error}
          </div>
        ))}
        <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
          {!picked ? (
            worktrees.isLoading ? (
              <div className="px-3 py-6 text-muted text-center flex items-center justify-center gap-2">
                <Spinner /> Loading worktrees
              </div>
            ) : worktrees.error ? (
              <div className="px-3 py-4 text-[13px] text-red">{(worktrees.error as Error).message}</div>
            ) : (
              <>
                <Command.Empty className="px-3 py-6 text-muted text-center">{list.length ? "No worktree matches." : "No worktrees. Set repo.path in your config first."}</Command.Empty>
                {list.map((w) => (
                  <Command.Item key={w.path} value={`${w.name} ${w.branch ?? ""} ${w.ticket ?? ""} ${w.main ? "main checkout" : ""} ${w.path}`} className={item} onSelect={() => pick(w.path)}>
                    <span className="font-medium shrink-0 max-w-[40%] truncate">{w.name}</span>
                    {w.main && <Tag tone="faint">main checkout</Tag>}
                    {w.ticket && !w.main && <Tag>{w.ticket}</Tag>}
                    <span className="truncate text-muted text-[12px]">{w.branch}</span>
                    {w.path === last && <span className="ml-auto text-[12px] text-faint shrink-0">last used</span>}
                  </Command.Item>
                ))}
              </>
            )
          ) : options.isLoading ? (
            <div className="px-3 py-6 text-muted text-center flex items-center justify-center gap-2">
              <Spinner /> Looking for what can run here
            </div>
          ) : options.error ? (
            <div className="px-3 py-4 text-[13px] text-red">{(options.error as Error).message}</div>
          ) : (
            <>
              <Command.Empty className="px-3 py-6 text-muted text-center">
                {!all.length ? "Nothing to run here: no package.json scripts, no verify command and nothing from plugins." : shown.length ? "Nothing matches." : `No ${kindLabel(kind as RunKind)} runs here.`}
              </Command.Empty>
              {groups.map((g) => (
                <Command.Group key={g} heading={g} className={group}>
                  {shown
                    .filter((o) => o.group === g)
                    .map((o) => (
                      <Command.Item key={o.id} value={`${o.label} ${o.detail ?? ""} ${o.group} ${o.id}`} className={item.replace("h-9", "min-h-9 py-1.5")} onSelect={() => start(o.id)}>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{o.label}</div>
                          {o.detail && <div className="truncate text-[12px] text-muted font-mono">{o.detail}</div>}
                        </div>
                        {busy === o.id ? <Spinner /> : <Tag tone="faint">{kindLabel(o.kind)}</Tag>}
                      </Command.Item>
                    ))}
                </Command.Group>
              ))}
            </>
          )}
        </Command.List>
        {picked && (
          <div className="px-3 py-1.5 border-t border-line text-[12px] text-faint flex">
            <span className="truncate">{shortPath(picked)}</span>
            <button onClick={lookAgain} disabled={looking || options.isFetching} className="ml-auto hover:text-ink shrink-0">
              {looking ? "Looking" : "Look again"}
            </button>
          </div>
        )}
      </Command>
    </div>
  );
}
