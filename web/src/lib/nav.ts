import type { ScreenInfo } from "@cockpit/shared";
import { useAppConfig } from "./queries";

export interface NavItem {
  // what Settings stores to hide it: the route for core screens, plugin:<id>/<screen> for plugin ones
  id: string;
  to: string;
  search?: Record<string, string>;
  label: string;
  key: string;
  plugin?: string;
  // hidden while no plugin provides it
  needs?: "tracker" | "codeHost";
  // other routes that light this entry up, like the screens that became its tabs
  also?: string[];
  // stays in ⌘K and on its g shortcut while it's out of the sidebar
  palette?: boolean;
}

export const coreNav: NavItem[] = [
  { to: "/", label: "Today", key: "t" },
  { to: "/board", label: "Work", key: "b", also: ["/tasks"] },
  { to: "/tickets", label: "Tickets", key: "j", also: ["/worktrees"] },
  { to: "/runs", label: "Runs", key: "n" },
  { to: "/flows", label: "Flows", key: "o" },
  { to: "/terminals", label: "Terminals", key: "x" },
  { to: "/sessions", label: "Sessions", key: "s", also: ["/workflows"] },
  { to: "/reviews", label: "Reviews", key: "v", needs: "codeHost" as const },
  { to: "/report", label: "Reports", key: "r", also: ["/weekly", "/usage"] },
  // out of the sidebar unless Settings turns them on: Code opens from links, Memory from Settings and ⌘K
  { to: "/code", label: "Code", key: "c" },
  { to: "/memory", label: "Memory & skills", key: "m", palette: true },
].map((n) => ({ ...n, id: n.to }));

export interface TabItem {
  value: string;
  label: string;
  to: string;
  search?: Record<string, string>;
  // the screens that became tabs keep their old id and g shortcut, so hiding one in Settings hides its tab.
  // A tab without an id goes with its screen.
  id?: string;
  key?: string;
  needs?: "tracker" | "codeHost";
}

// Screens made of tabs, by the screen's id. Hiding the screen hides all of its tabs; hiding a tab only drops it.
export const screenTabs: Record<string, TabItem[]> = {
  "/tickets": [
    { value: "tickets", label: "Tickets", to: "/tickets", needs: "tracker" },
    { value: "worktrees", label: "Worktrees", to: "/tickets", search: { tab: "worktrees" }, id: "/worktrees", key: "w" },
  ],
  "/sessions": [
    { value: "sessions", label: "Sessions", to: "/sessions" },
    { value: "workflows", label: "Workflows", to: "/sessions", search: { tab: "workflows" }, id: "/workflows", key: "f" },
  ],
  "/report": [
    { value: "sprint", label: "Sprint", to: "/report", id: "/report#sprint", needs: "tracker" },
    { value: "week", label: "Week", to: "/weekly", id: "/weekly", key: "k" },
    { value: "usage", label: "Usage", to: "/usage", id: "/usage", key: "u" },
  ],
};

// always there, so there's somewhere to land and a way back to turn things on
export const fixedNav = ["/", "/settings"];
const settingsNav: NavItem = { id: "/settings", to: "/settings", label: "Settings", key: "," };

export const screenNav = (s: ScreenInfo): NavItem => ({ id: `plugin:${s.plugin}/${s.id}`, to: `/p/${s.plugin}/${s.id}`, label: s.title, key: "", plugin: s.plugin });

// A screen's tabs that show: not hidden and with what they need, plus the one open now whatever Settings says,
// since hidden only means it's out of the way.
export function useTabs(screen: string, current?: string) {
  const cfg = useAppConfig();
  const hidden = new Set(cfg.data?.hidden ?? []);
  return (screenTabs[screen] ?? []).filter((t) => t.value === current || ((!t.id || !hidden.has(t.id)) && (!t.needs || !!cfg.data?.[t.needs])));
}

// Core screens and plugin screens, minus what Settings hides. The sidebar shows them in two groups with
// Settings as an icon at the bottom; ⌘K and the g shortcuts also get the tabs and the screens kept for ⌘K.
export function useNavGroups() {
  const cfg = useAppConfig();
  const hidden = new Set(cfg.data?.hidden ?? []);
  const has = (n: { needs?: NavItem["needs"] }) => !n.needs || !!cfg.data?.[n.needs];
  const shown = (n: NavItem) => fixedNav.includes(n.id) || (!hidden.has(n.id) && has(n));
  const tabsOf = (n: NavItem) => (screenTabs[n.id] ?? []).filter((t) => (!t.id || !hidden.has(t.id)) && has(t));
  // a screen of tabs opens on its first tab that shows, and leaves the sidebar when none does
  const core = coreNav
    .filter((n) => shown(n) && (!screenTabs[n.id] || tabsOf(n).length))
    .map((n) => {
      const first = screenTabs[n.id] ? tabsOf(n)[0] : undefined;
      return first ? { ...n, to: first.to, search: first.search } : n;
    });
  const tabs: NavItem[] = core.flatMap((n) => tabsOf(n).filter((t) => t.key).map((t) => ({ id: t.id!, to: t.to, search: t.search, label: t.label === "Week" ? "Your week" : t.label, key: t.key! })));
  // plugin pages of settings live on the Settings page, and ⌘K still finds them
  const screens = cfg.data?.screens ?? [];
  const extra = [...coreNav.filter((n) => n.palette && !shown(n) && has(n)), ...screens.filter((s) => s.settings).map((s) => ({ ...screenNav(s), label: `${s.title}, in Settings` }))];
  return { core, plugins: screens.filter((s) => !s.settings).map(screenNav).filter(shown), settings: settingsNav, tabs, extra, settingsPages: screens.filter((s) => s.settings) };
}

// Where you were before opening a session, so its page can take you back there. Layout keeps it up to date.
let before: { href: string; path: string } | undefined;
export const place = {
  set: (href: string, path: string) => void (before = { href, path }),
  get: () => before,
};

const details: [string, string][] = [
  ["/workflows/", "Workflow"],
  ["/tasks/", "Task"],
  ["/flows/", "Flow"],
  ["/runs/", "Run"],
];

// what to call a place in a breadcrumb: its tab, its screen, or what its detail page shows
export function placeLabel(path: string, search: string, screens: ScreenInfo[] = []) {
  const tab = new URLSearchParams(search).get("tab");
  for (const tabs of Object.values(screenTabs)) {
    const t = tabs.find((t) => t.to === path && (t.search?.tab ?? null) === tab && t.key);
    if (t) return t.label === "Week" ? "Your week" : t.label;
  }
  const detail = details.find(([p]) => path.startsWith(p));
  if (detail) return detail[1];
  const plugin = screens.map(screenNav).find((n) => path === n.to);
  if (plugin) return plugin.label;
  const core = coreNav.find((n) => (n.to === "/" ? path === "/" : path.startsWith(n.to) || n.also?.some((a) => path.startsWith(a))));
  return core?.label ?? (path === "/settings" ? "Settings" : "Back");
}
