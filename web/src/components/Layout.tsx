import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useConnected } from "../lib/live";
import { useNavGroups, type NavItem } from "../lib/nav";
import { useAppConfig } from "../lib/queries";
import { useSettings } from "../lib/cost";
import { fontStore } from "../lib/fonts";
import { themeStore } from "../lib/theme";
import { CommandPalette } from "./CommandPalette";
import { UsageMini } from "./UsageMini";
import { TerminalLauncher } from "./TerminalLauncher";
import { SessionStrip } from "./SessionStrip";
import { ThemePicker } from "./ThemePicker";
import { notifyStore, useNotifyMode, type NotifyMode } from "../lib/notifications";
import { Kbd } from "./ui";


const NOTIFY_NEXT: Record<NotifyMode, NotifyMode> = { background: "always", always: "off", off: "background" };
const NOTIFY_LABEL: Record<NotifyMode, string> = { background: "Alerts when away", always: "Alerts always", off: "Alerts off" };

// cycles: only when cockpit isn't focused, always, off
function NotifyToggle() {
  const mode = useNotifyMode();
  return (
    <button onClick={() => notifyStore.set(NOTIFY_NEXT[mode])} className={`hover:text-ink ${mode === "off" ? "line-through" : ""}`} title="Notify me when Claude is waiting, a review or call is ready, or usage passes 80%">
      {NOTIFY_LABEL[mode]}
    </button>
  );
}

// the logo in the theme's own colours
const Logo = () => (
  <svg viewBox="50 50 412 412" className="size-6" aria-hidden>
    <rect x="50" y="50" width="412" height="412" rx="92" fill="var(--ground)" stroke="var(--line)" strokeWidth="8" />
    <path d="M 314.7 185.3 A 100 100 0 1 0 314.7 326.7" fill="none" stroke="var(--cobalt)" strokeWidth="56" strokeLinecap="round" />
    <circle cx="354" cy="256" r="32" fill="var(--amber)" />
  </svg>
);

export function Layout() {
  const connected = useConnected();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [menu, setMenu] = useState(false);
  const groups = useNavGroups();
  const nav = [...groups.core, ...groups.plugins, groups.settings];
  const item = (n: NavItem) => {
    const active = n.to === "/" ? path === "/" : path.startsWith(n.to);
    return (
      <Link
        key={n.to}
        to={n.to}
        className={`flex items-center h-8 px-2.5 rounded-md text-[14px] ${active ? "bg-cobalt-soft text-cobalt font-medium" : "text-muted hover:text-ink hover:bg-ground"}`}
      >
        <span className="flex-1 truncate">{n.label}</span>
        {n.key && <span className="text-[11px] text-faint font-mono">g {n.key}</span>}
      </Link>
    );
  };
  const cfg = useAppConfig();
  const pluginThemes = cfg.data?.themes;
  useEffect(() => {
    if (pluginThemes) themeStore.setExtra(pluginThemes);
  }, [pluginThemes]);
  const fonts = useSettings().data?.settings.fonts;
  useEffect(() => {
    if (fonts) fontStore.set(fonts);
  }, [fonts]);
  const fullBleed = path.startsWith("/code") || path.startsWith("/terminals") || path.startsWith("/memory") || path.startsWith("/p/");

  useEffect(() => setMenu(false), [path]);

  // pages meant to sit in a plugin's frame get no chrome
  if (path.startsWith("/embed/")) return <Outlet />;

  return (
    <div className="h-full flex">
      <aside
        className={`${menu ? "flex" : "hidden"} md:flex fixed md:static z-30 inset-y-0 left-0 w-[196px] shrink-0 flex-col border-r border-line bg-panel`}
      >
        <div className="drag traffic flex items-center gap-2 px-4 h-14">
          <Logo />
          <span className="font-semibold text-[16px] tracking-tight">cockpit</span>
        </div>
        <nav className="flex flex-col gap-px px-2 flex-1 min-h-0 overflow-y-auto">
          {groups.core.map(item)}
          {!!groups.plugins.length && (
            <>
              <div className="border-t border-line mx-2.5 my-2" role="separator" />
              {groups.plugins.map(item)}
            </>
          )}
        </nav>
        <UsageMini />
        <div className="px-4 py-3 border-t border-line flex items-center gap-2 text-[12px] text-muted">
          <span className={`size-2 rounded-full ${connected ? "bg-green" : "bg-red"}`} />
          <span className="flex-1">{connected ? "Live" : "Reconnecting"}</span>
          <ThemePicker />
          <Link
            to="/settings"
            className={`-mr-1 size-6 grid place-items-center rounded ${path.startsWith("/settings") ? "text-cobalt bg-cobalt-soft" : "hover:text-ink hover:bg-ground"}`}
            title="Settings (g ,)"
            aria-label="Settings"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 8.92a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.92 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.6.76 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </Link>
        </div>
        <div className="px-4 pb-1 text-[12px] text-faint">
          <NotifyToggle />
        </div>
        <div className="px-4 pb-3 text-[12px] text-faint">
          <Kbd>⌘K</Kbd> to jump anywhere
        </div>
      </aside>
      {menu && <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={() => setMenu(false)} />}

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-stretch">
          <button className="md:hidden px-4 border-b border-line bg-panel text-muted" onClick={() => setMenu(true)} aria-label="Menu">
            ☰
          </button>
          <div className="flex-1 min-w-0">
            <SessionStrip />
          </div>
        </div>
        <main className={`flex-1 min-h-0 ${fullBleed ? "" : "overflow-y-auto px-4 md:px-6 py-5"}`}>
          <Outlet />
        </main>
      </div>
      <CommandPalette nav={nav} />
      <TerminalLauncher />
    </div>
  );
}
