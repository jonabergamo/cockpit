import type { ScreenInfo } from "@cockpit/shared";
import { useAppConfig } from "./queries";

export interface NavItem {
  // what Settings stores to hide it: the route for core screens, plugin:<id>/<screen> for plugin ones
  id: string;
  to: string;
  label: string;
  key: string;
  plugin?: string;
  // hidden while no plugin provides it
  needs?: "tracker" | "codeHost";
}

export const coreNav: NavItem[] = [
  { to: "/", label: "Today", key: "t" },
  { to: "/board", label: "Board", key: "b" },
  { to: "/sessions", label: "Sessions", key: "s" },
  { to: "/workflows", label: "Workflows", key: "f" },
  { to: "/tickets", label: "Tickets", key: "j", needs: "tracker" as const },
  { to: "/worktrees", label: "Worktrees", key: "w" },
  { to: "/code", label: "Code", key: "c" },
  { to: "/terminals", label: "Terminals", key: "x" },
  { to: "/memory", label: "Memory & skills", key: "m" },
  { to: "/reviews", label: "PR reviews", key: "v", needs: "codeHost" as const },
  { to: "/report", label: "Sprint report", key: "r", needs: "tracker" as const },
  { to: "/usage", label: "Usage", key: "u" },
].map((n) => ({ ...n, id: n.to }));

// always there, so there's somewhere to land and a way back to turn things on
export const fixedNav = ["/", "/settings"];
const settingsNav: NavItem = { id: "/settings", to: "/settings", label: "Settings", key: "," };

export const screenNav = (s: ScreenInfo): NavItem => ({ id: `plugin:${s.plugin}/${s.id}`, to: `/p/${s.plugin}/${s.id}`, label: s.title, key: "", plugin: s.plugin });

// Core screens and plugin screens, minus what Settings hides. The sidebar shows them in two groups with
// Settings as an icon at the bottom; ⌘K and the g shortcuts get the whole list.
export function useNavGroups() {
  const cfg = useAppConfig();
  const hidden = new Set(cfg.data?.hidden ?? []);
  const has = (n: NavItem) => !n.needs || !!cfg.data?.[n.needs];
  const shown = (n: NavItem) => fixedNav.includes(n.id) || (!hidden.has(n.id) && has(n));
  return { core: coreNav.filter(shown), plugins: (cfg.data?.screens ?? []).map(screenNav).filter(shown), settings: settingsNav };
}
