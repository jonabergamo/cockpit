import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useDeferredValue, useEffect, useState } from "react";
import { Snippet, useSaid } from "../pages/Sessions";
import { type ConfigFile, type Session, type Ticket, type Worktree } from "@cockpit/shared";
import { api } from "../lib/api";
import { shortPath } from "../lib/format";
import { launcher } from "../lib/launcher";
import { newTask } from "./NewTask";
import { runSomething } from "./RunSomething";
import { useAppConfig } from "../lib/queries";
import { askCockpit } from "./AskPanel";
import { themeStore, useThemes } from "../lib/theme";

interface NavItem {
  id: string;
  to: string;
  search?: Record<string, string>;
  label: string;
  key: string;
}

export const item = "flex items-center gap-2 px-3 h-9 rounded-md cursor-pointer text-[14px] data-[selected=true]:bg-cobalt-soft data-[selected=true]:text-cobalt";
export const group = "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-faint";

export function CommandPalette({ nav }: { nav: readonly NavItem[] }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  // a group only shows, and only asks for its data, when the screen it opens is in the sidebar
  const visible = (to: string) => nav.some((n) => n.to === to);
  const said = useSaid(open && visible("/sessions") && deferred.length >= 3 ? deferred : "");
  const navigate = useNavigate();
  const themes = useThemes();

  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.closest(".monaco-editor, .xterm")) return;
      if (e.key === "g" && !e.metaKey && !e.ctrlKey) {
        pendingG = Date.now();
        return;
      }
      if (Date.now() - pendingG < 800) {
        const n = nav.find((x) => x.key === e.key);
        if (n) navigate({ to: n.to, search: n.search as never });
        pendingG = 0;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav, navigate]);

  const cfg = useAppConfig();
  const tickets = useQuery({ queryKey: ["tickets"], queryFn: () => api.get<{ tickets: Ticket[] }>("/tickets"), enabled: open && !!cfg.data?.tracker && visible("/tickets") });
  // worktrees open in Code, which is out of the sidebar by default, so they go with Tickets, where their tab is
  const worktrees = useQuery({ queryKey: ["worktrees"], queryFn: () => api.get<Worktree[]>("/worktrees"), enabled: open && (visible("/tickets") || visible("/code")) });
  const sessions = useQuery({ queryKey: ["sessions", "recent"], queryFn: () => api.get<Session[]>("/sessions?limit=60"), enabled: open && visible("/sessions") });
  const files = useQuery({ queryKey: ["claude-files"], queryFn: () => api.get<ConfigFile[]>("/claude/files"), enabled: open && visible("/memory") });

  const go = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-black/30" />
      <Command
        label="Jump to"
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-xl bg-panel border border-line rounded-lg shadow-xl overflow-hidden"
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      >
        <Command.Input value={search} onValueChange={setSearch} autoFocus placeholder="Ticket, worktree, session or page, or ask a question" className="w-full h-12 px-4 bg-transparent border-b border-line outline-none" />
        <Command.List className="max-h-[55vh] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-muted text-center">Nothing matches.</Command.Empty>
          {search.trim().split(/\s+/).length >= 3 && (
            <Command.Group heading="Ask" className={group}>
              {/* the search text is in the value so cmdk's own filter keeps it */}
              <Command.Item value={`${search} ask cockpit`} className={item} onSelect={() => go(() => askCockpit.open(search.trim()))}>
                <span className="shrink-0 text-cobalt">Ask cockpit:</span>
                <span className="truncate">{search.trim()}</span>
              </Command.Item>
            </Command.Group>
          )}
          <Command.Group heading="Terminals" className={group}>
            <Command.Item value="new terminal shell claude launch" className={item} onSelect={() => go(launcher.open)}>
              New terminal…
            </Command.Item>
            <Command.Item value="new task queue worktree claude attempts" className={item} onSelect={() => go(() => newTask.open())}>
              New task…
            </Command.Item>
            <Command.Item value="run something test lint typecheck audit e2e ci verify script" className={item} onSelect={() => go(() => runSomething.open())}>
              Run something…
            </Command.Item>
          </Command.Group>
          <Command.Group heading="Pages" className={group}>
            {nav.map((n) => (
              <Command.Item key={n.id} className={item} onSelect={() => go(() => navigate({ to: n.to, search: n.search as never }))}>
                {n.label}
              </Command.Item>
            ))}
          </Command.Group>
          {visible("/tickets") && (
          <Command.Group heading="Tickets" className={group}>
            {tickets.data?.tickets.map((t) => (
              <Command.Item key={t.key} value={`${t.key} ${t.summary}`} className={item} onSelect={() => go(() => navigate({ to: "/tickets", search: { key: t.key } }))}>
                <span className="font-medium shrink-0">{t.key}</span>
                <span className="truncate text-muted">{t.summary}</span>
              </Command.Item>
            ))}
          </Command.Group>
          )}
          {(visible("/tickets") || visible("/code")) && (
          <Command.Group heading="Worktrees" className={group}>
            {worktrees.data?.map((w) => (
              <Command.Item key={w.path} value={`worktree ${w.name} ${w.branch ?? ""}`} className={item} onSelect={() => go(() => navigate({ to: "/code", search: { root: w.path } }))}>
                <span className="font-medium shrink-0">{w.name}</span>
                <span className="truncate text-muted">{w.branch}</span>
              </Command.Item>
            ))}
          </Command.Group>
          )}
          {visible("/sessions") && (
          <Command.Group heading="Sessions" className={group}>
            {sessions.data?.map((s) => (
              <Command.Item key={s.id} value={`session ${s.title ?? ""} ${s.ticket ?? ""} ${s.id}`} className={item} onSelect={() => go(() => navigate({ to: "/sessions/$id", params: { id: s.id } }))}>
                <span className="truncate">{s.title ?? s.id.slice(0, 8)}</span>
                <span className="truncate text-muted ml-auto text-[12px]">{shortPath(s.cwd)}</span>
              </Command.Item>
            ))}
          </Command.Group>
          )}
          {visible("/memory") && (
          <Command.Group heading="Memory, skills and config" className={group}>
            {files.data?.map((f) => (
              <Command.Item key={f.path} value={`${f.group} ${f.label} ${f.project ?? ""}`} className={item} onSelect={() => go(() => navigate({ to: "/memory", search: { path: f.path } }))}>
                <span className="truncate">{f.label}</span>
                <span className="truncate text-muted ml-auto text-[12px]">{f.project ?? f.group}</span>
              </Command.Item>
            ))}
          </Command.Group>
          )}
          {!!said.data?.length && (
            <Command.Group heading="Said in sessions" className={group}>
              {said.data.slice(0, 6).map((s) => (
                // the search text is in the value so cmdk's own filter keeps these
                <Command.Item key={s.id} value={`${search} said ${s.id}`} className={item.replace("h-9", "min-h-9 py-1.5")} onSelect={() => go(() => navigate({ to: "/sessions/$id", params: { id: s.id } }))}>
                  <div className="min-w-0">
                    <div className="truncate">{s.title ?? s.id.slice(0, 8)}</div>
                    <div className="truncate text-[12px] text-muted">
                      <Snippet text={s.hits[0]?.snippet ?? ""} />
                    </div>
                  </div>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Theme" className={group}>
            <Command.Item value="theme auto system" className={item} onSelect={() => go(() => themeStore.choose("auto"))}>
              Theme: Auto
            </Command.Item>
            {themes.map((t) => (
              <Command.Item key={t.id} value={`theme ${t.name} ${t.scheme}`} className={item} onSelect={() => go(() => themeStore.choose(t.id))}>
                <span className="truncate">Theme: {t.name}</span>
                <span className="text-muted ml-auto text-[12px]">{t.scheme}</span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
