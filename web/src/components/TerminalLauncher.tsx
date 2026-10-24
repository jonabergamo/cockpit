import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useDeferredValue, useEffect, useState } from "react";
import type { Machine, Session } from "@cockpit/shared";
import { api } from "../lib/api";
import { shortPath } from "../lib/format";
import { launch, launcher, MODES, recentOn, useLauncher, type LaunchMode } from "../lib/launcher";
import { group, item } from "./CommandPalette";
import { useRoots } from "./RootPicker";

// Recent sessions often run in a subfolder (an app inside the repo), so map each one back to the
// worktree, project or saved folder it belongs to; those are the folders the server lets a terminal open in.
export function useRecentFolders() {
  const roots = useRoots();
  const sessions = useQuery({ queryKey: ["sessions", "recent"], queryFn: () => api.get<Session[]>("/sessions?limit=60") });
  const all = [...(roots.data?.worktrees.filter((w) => !w.node).map((w) => w.path) ?? []), ...(roots.data?.projects ?? []), ...(roots.data?.folders ?? [])].sort((a, b) => b.length - a.length);
  const rootOf = (cwd: string) => all.find((r) => cwd === r || cwd.startsWith(r + "/"));
  const out: string[] = [];
  for (const s of sessions.data ?? []) {
    const r = rootOf(s.cwd);
    if (r && !out.includes(r)) out.push(r);
    if (out.length === 8) break;
  }
  const label = (p: string) => roots.data?.worktrees.find((w) => w.path === p)?.name ?? shortPath(p).split("/").pop()!;
  return { folders: out, all, label, ready: roots.isSuccess && sessions.isSuccess };
}

const modeLabel: Record<LaunchMode, string> = { claude: "Claude", resume: "Resume", shell: "Shell" };

// Pick a folder, or type any path in your home, and start Claude, the resume picker or a shell there.
export function TerminalLauncher() {
  const { open, mode, node: picked } = useLauncher();
  const machines = useQuery({ queryKey: ["machines"], queryFn: () => api.get<{ machines: Machine[] }>("/machines"), enabled: open });
  const others = machines.data?.machines ?? [];
  // auto is the first connected node, so work goes where the repo and the tools are; this machine stands in when
  // none is connected, or when picked
  const up = others.filter((m) => m.state === "up");
  const node = picked === "local" ? "local" : up.some((m) => m.id === picked) ? picked : (up[0]?.id ?? "local");
  const remote = others.find((m) => m.id === node);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const roots = useRoots();
  const { folders: recent, all, label } = useRecentFolders();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const typed = useDeferredValue(search.trim());
  const pathMode = typed.startsWith("/") || typed.startsWith("~");
  const base = pathMode ? typed.slice(0, typed.lastIndexOf("/") + 1) || "~/" : "";
  const dirs = useQuery({ queryKey: ["dirs", node, base], queryFn: () => api.get<{ path: string; dirs: string[] }>(`/code/dirs?path=${encodeURIComponent(base)}&node=${node}`), enabled: open && pathMode });

  useEffect(() => {
    if (!open) {
      setSearch("");
      setErr(undefined);
    }
  }, [open]);

  if (!open) return null;

  const start = async (cwd: string, m: LaunchMode = mode) => {
    setBusy(true);
    setErr(undefined);
    try {
      if (node !== "local") {
        const id = await launch(qc, cwd, m, cwd.split("/").filter(Boolean).pop() ?? cwd, node);
        launcher.close();
        return navigate({ to: "/terminals", search: { id } });
      }
      // anything outside the known roots gets saved first, which is what lets the server open it
      if (!all.includes(cwd)) await api.post("/code/folders", { path: cwd });
      await qc.invalidateQueries({ queryKey: ["roots"] });
      const id = await launch(qc, cwd, m, label(cwd));
      launcher.close();
      navigate({ to: "/terminals", search: { id } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (p: string) => {
    await api.del(`/code/folders?path=${encodeURIComponent(p)}`);
    await qc.invalidateQueries({ queryKey: ["roots"] });
  };

  const row = (key: string, path: string, name: string, sub?: string, onForget?: () => void) => (
    <Command.Item key={key + path} value={`${key} ${name} ${path}`} className={`${item} group`} onSelect={() => start(path)}>
      <span className="font-medium shrink-0 max-w-[45%] truncate">{name}</span>
      <span className="truncate text-muted text-[12px]">{sub ?? shortPath(path)}</span>
      <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100">
        {MODES.map((m) => (
          <button
            key={m}
            onClick={(e) => {
              e.stopPropagation();
              start(path, m);
            }}
            className="px-1.5 h-6 rounded text-[12px] text-muted hover:text-ink hover:bg-raised"
          >
            {m}
          </button>
        ))}
        {onForget && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onForget();
            }}
            className="size-6 rounded text-faint hover:text-red hover:bg-red-soft"
            aria-label="Forget this folder"
          >
            ×
          </button>
        )}
      </span>
    </Command.Item>
  );

  // typed paths are matched by prefix, not cmdk's fuzzy filter
  const want = typed.replace(/^~/, "");
  const matches = (dirs.data?.dirs ?? []).filter((d) => shortPath(d).replace(/^~/, "").startsWith(want) || d.startsWith(typed));
  const baseFull = dirs.data?.path;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4" onClick={() => launcher.close()}>
      <div className="absolute inset-0 bg-black/30" />
      <Command
        label="New terminal"
        shouldFilter={!pathMode}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-xl bg-panel border border-line rounded-lg shadow-xl overflow-hidden"
        onKeyDown={(e) => {
          if (e.key === "Escape") launcher.close();
          if (e.key === "Tab") {
            e.preventDefault();
            launcher.setMode(MODES[(MODES.indexOf(mode) + (e.shiftKey ? MODES.length - 1 : 1)) % MODES.length]);
          }
        }}
      >
        <div className="flex items-center gap-1 px-3 pt-3">
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => launcher.setMode(m)}
              className={`px-2.5 h-7 rounded text-[13px] font-medium ${mode === m ? "bg-raised text-ink shadow-[0_0_0_1px_var(--line)]" : "text-muted hover:text-ink"}`}
            >
              {modeLabel[m]}
            </button>
          ))}
          <span className="ml-auto text-[12px] text-faint">{busy ? "Starting" : "Tab switches · ⏎ starts"}</span>
        </div>
        {others.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 px-3 pt-2 text-[12px]">
            <span className="text-faint mr-1">On</span>
            {[{ id: "local", name: "this machine", state: "up" as const }, ...others].map((m) => (
              <button
                key={m.id}
                onClick={() => launcher.setNode(m.id)}
                disabled={m.state !== "up"}
                title={m.state !== "up" ? `${m.name} isn't connected` : undefined}
                className={`flex items-center gap-1.5 px-2 h-6 rounded ${node === m.id ? "bg-raised text-ink shadow-[0_0_0_1px_var(--line)]" : "text-muted hover:text-ink"} disabled:opacity-40`}
              >
                <span className={`size-1.5 rounded-full ${m.state === "up" ? "bg-green" : "bg-line"}`} />
                {m.name}
              </button>
            ))}
          </div>
        )}
        <Command.Input value={search} onValueChange={setSearch} autoFocus placeholder={remote ? `A folder on ${remote.name}, like ~/code/app` : "Folder name, or a path like ~/work/app"} className="w-full h-12 px-4 bg-transparent border-b border-line outline-none" />
        {err && <div className="px-4 py-2 text-[13px] text-red border-b border-line">{err}</div>}
        <Command.List className="max-h-[55vh] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-muted text-center">{remote ? `Type the path of a folder on ${remote.name}.` : pathMode ? (dirs.isLoading ? "Reading folders" : "No folders there.") : "Nothing matches. Type a path starting with ~ or /."}</Command.Empty>
          {remote && pathMode ? (
            <Command.Group heading={`On ${remote.name}`} className={group}>
              {row("typed", baseFull && typed.endsWith("/") ? baseFull : typed, typed.split("/").filter(Boolean).pop() ?? typed, `${typed} · on ${remote.name}`)}
              {matches.map((d) => row("dir", d, d.split("/").pop()!, `${d} · on ${remote.name}`))}
            </Command.Group>
          ) : remote ? (
            <>
              <Command.Group heading={`Recent on ${remote.name}`} className={group}>
                {recentOn(node).map((p) => row("node", p, p.split("/").filter(Boolean).pop() ?? p, `${p} · on ${remote.name}`))}
              </Command.Group>
              <Command.Group heading="Worktrees" className={group}>
                {roots.data?.worktrees.filter((w) => w.node === node).map((w) => row("worktree", w.path, w.name, w.branch))}
              </Command.Group>
              <Command.Group heading="Projects and saved folders" className={group}>
                {roots.data?.remote?.filter((r) => r.node === node).map((r) => row(r.kind, r.path, r.path.split("/").pop() ?? r.path, r.path))}
              </Command.Group>
            </>
          ) : pathMode ? (
            <Command.Group heading="Path" className={group}>
              {baseFull && typed.endsWith("/") && row("here", baseFull, shortPath(baseFull).split("/").pop() || "~", `${shortPath(baseFull)} · this folder`)}
              {matches.map((d) => row("dir", d, d.split("/").pop()!, shortPath(d)))}
            </Command.Group>
          ) : (
            <>
              <Command.Group heading="Recent" className={group}>
                {recent.map((p) => row("recent", p, label(p)))}
              </Command.Group>
              <Command.Group heading="Saved" className={group}>
                {roots.data?.folders.map((p) => row("saved", p, label(p), undefined, () => forget(p)))}
              </Command.Group>
              <Command.Group heading="Worktrees" className={group}>
                {roots.data?.worktrees.filter((w) => !w.node).map((w) => row("worktree", w.path, w.name, w.branch))}
              </Command.Group>
              <Command.Group heading="Projects" className={group}>
                {roots.data?.projects.map((p) => row("project", p, label(p)))}
              </Command.Group>
            </>
          )}
        </Command.List>
      </Command>
    </div>
  );
}
