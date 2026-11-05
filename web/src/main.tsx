import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "./components/Layout";
import { EmbedTerminal } from "./components/EmbedTerminal";
import { PluginFrame } from "./components/PluginFrame";
import { SETTINGS_TABS, SettingsPage, type SettingsTab } from "./pages/Settings";
import { listen } from "./lib/live";
import { tabId } from "./lib/canvas";
import { show } from "./lib/notifications";
import { installPluginHost } from "./lib/pluginHost";
import { watchForUpdates } from "./lib/update";
import type { Job } from "./lib/queries";
import type { Machine } from "@cockpit/shared";
import "./lib/theme";
import "./index.css";

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

// each screen is fetched the first time it's opened, so the window shows sooner (the code editor alone is megabytes)
const root = createRootRoute({ component: Layout });

// Screens that became a tab or a filter of another keep their address: it lands on that tab, query string and all.
const moved = (path: string, to: string, extra: Record<string, string>) =>
  createRoute({
    getParentRoute: () => root,
    path,
    beforeLoad: ({ search }) => {
      throw redirect({ to, search: { ...(search as object), ...extra } as never, replace: true });
    },
  });

const routes = [
  createRoute({ getParentRoute: () => root, path: "/", component: lazyRouteComponent(() => import("./pages/Today"), "TodayPage") }),
  createRoute({ getParentRoute: () => root, path: "/board", component: lazyRouteComponent(() => import("./pages/Board"), "BoardPage"), validateSearch: (s): { card?: string; filter?: "tasks"; view?: "tickets" | "board" | "tasks" } => ({ card: str(s.card), filter: s.filter === "tasks" ? "tasks" : undefined, view: s.view === "tickets" || s.view === "board" || s.view === "tasks" ? s.view : undefined }) }),
  moved("/tasks", "/board", { filter: "tasks" }),
  createRoute({ getParentRoute: () => root, path: "/tasks/$group", component: lazyRouteComponent(() => import("./pages/Tasks"), "TaskGroupPage") }),
  createRoute({ getParentRoute: () => root, path: "/sessions", component: lazyRouteComponent(() => import("./pages/Hubs"), "SessionsScreen"), validateSearch: (s): { tab?: "workflows" } => ({ tab: s.tab === "workflows" ? "workflows" : undefined }) }),
  createRoute({ getParentRoute: () => root, path: "/sessions/$id", component: lazyRouteComponent(() => import("./pages/Session"), "SessionPage"), validateSearch: (s): { agent?: string } => ({ agent: str(s.agent) }) }),
  moved("/workflows", "/sessions", { tab: "workflows" }),
  createRoute({ getParentRoute: () => root, path: "/workflows/$id", component: lazyRouteComponent(() => import("./pages/Workflows"), "WorkflowPage") }),
  createRoute({ getParentRoute: () => root, path: "/tickets", component: lazyRouteComponent(() => import("./pages/Hubs"), "TicketsScreen"), validateSearch: (s): { key?: string; tab?: "worktrees" } => ({ key: str(s.key), tab: s.tab === "worktrees" ? "worktrees" : undefined }) }),
  moved("/worktrees", "/tickets", { tab: "worktrees" }),
  createRoute({ getParentRoute: () => root, path: "/code", component: lazyRouteComponent(() => import("./pages/Code"), "CodePage"), validateSearch: (s): { root?: string; file?: string; diff?: boolean } => ({ root: str(s.root), file: str(s.file), diff: s.diff === true || s.diff === "1" || undefined }) }),
  createRoute({ getParentRoute: () => root, path: "/terminals", component: lazyRouteComponent(() => import("./pages/Terminals"), "TerminalsPage"), validateSearch: (s): { id?: string; resume?: string; pid?: number; view?: "tabs" | "canvas"; ticket?: string } => ({ id: str(s.id), resume: str(s.resume), pid: s.pid ? Number(s.pid) : undefined, view: s.view === "canvas" || s.view === "tabs" ? s.view : undefined, ticket: str(s.ticket) }) }),
  moved("/canvas", "/terminals", { view: "canvas" }),
  createRoute({ getParentRoute: () => root, path: "/memory", component: lazyRouteComponent(() => import("./pages/Memory"), "MemoryPage"), validateSearch: (s): { path?: string } => ({ path: str(s.path) }) }),
  createRoute({ getParentRoute: () => root, path: "/usage", component: lazyRouteComponent(() => import("./pages/Hubs"), "UsageScreen") }),
  createRoute({ getParentRoute: () => root, path: "/weekly", component: lazyRouteComponent(() => import("./pages/Hubs"), "WeekScreen"), validateSearch: (s): { week?: string } => ({ week: str(s.week) }) }),
  createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsPage, validateSearch: (s): { tab?: SettingsTab } => ({ tab: SETTINGS_TABS.includes(s.tab as SettingsTab) ? (s.tab as SettingsTab) : undefined }) }),
  createRoute({ getParentRoute: () => root, path: "/runs", component: lazyRouteComponent(() => import("./pages/Runs"), "RunsPage"), validateSearch: (s): { kind?: string; status?: string; ticket?: string; worktree?: string; group?: string; summary?: string } => ({ kind: str(s.kind), status: str(s.status), ticket: str(s.ticket), worktree: str(s.worktree), group: str(s.group), summary: str(s.summary) }) }),
  createRoute({ getParentRoute: () => root, path: "/runs/$id", component: lazyRouteComponent(() => import("./pages/Runs"), "RunPage") }),
  createRoute({ getParentRoute: () => root, path: "/p/$plugin/$screen", component: PluginFrame }),
  createRoute({ getParentRoute: () => root, path: "/embed/terminal/$id", component: EmbedTerminal }),
  createRoute({ getParentRoute: () => root, path: "/reviews", component: lazyRouteComponent(() => import("./pages/Reviews"), "ReviewsPage"), validateSearch: (s): { id?: number; pr?: string } => ({ id: s.id ? Number(s.id) : undefined, pr: str(s.pr) }) }),
  createRoute({ getParentRoute: () => root, path: "/report", component: lazyRouteComponent(() => import("./pages/Hubs"), "ReportScreen"), validateSearch: (s): { sprint?: number; scope?: "me" } => ({ sprint: s.sprint ? Number(s.sprint) : undefined, scope: s.scope === "me" ? "me" : undefined }) }),
];

const router = createRouter({ routeTree: root.addChildren(routes), defaultPreload: "intent" });

// a click on a desktop notification lands here
window.desktop?.onNavigate?.((link) => router.history.push(link));

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Everything loads once and stays until the user refreshes or changes it; live state arrives over the socket.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 } },
});

installPluginHost((to) => router.history.push(to));
watchForUpdates();

listen((ev) => {
  if (ev.type === "terms") queryClient.setQueryData(["terms"], ev.terms);
  // a change this tab made is already on screen
  if (ev.type === "canvas" && ev.by !== tabId) queryClient.invalidateQueries({ queryKey: ["canvas"] });
  if (ev.type === "badges") queryClient.setQueryData(["badges"], ev.badges);
  if (ev.type === "plugins") queryClient.invalidateQueries({ queryKey: ["config"] }), queryClient.invalidateQueries({ queryKey: ["plugins"] });
  // whether each machine can be reached, for every screen that picks one (the terminal launcher, say)
  if (ev.type === "machines") queryClient.setQueryData<{ machines: Machine[] }>(["machines"], (d) => d && { ...d, machines: ev.machines });
  // a node that connected brings its repo, worktrees, folders and tickets with it
  if (ev.type === "node.ready") for (const key of ["config", "worktrees", "roots", "tickets", "board", "badges"]) queryClient.invalidateQueries({ queryKey: [key] });
  if (ev.type === "notify") show(ev, (link) => router.history.push(link));
  if (ev.type === "run") queryClient.invalidateQueries({ queryKey: ["runs"] }), queryClient.invalidateQueries({ queryKey: ["run", ev.run.id] });
  if (ev.type === "job") {
    const list = queryClient.getQueryData<Job[]>(["jobs"]);
    if (!list?.some((j) => j.id === ev.id)) return void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    queryClient.setQueryData<Job[]>(
      ["jobs"],
      list.map((j) => (j.id !== ev.id ? j : { ...j, output: j.output + (ev.chunk ?? ""), code: ev.done ? ev.code : j.code })),
    );
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
