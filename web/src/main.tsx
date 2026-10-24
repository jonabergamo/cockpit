import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, redirect, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "./components/Layout";
import { EmbedTerminal } from "./components/EmbedTerminal";
import { PluginFrame } from "./components/PluginFrame";
import { BoardPage } from "./pages/Board";
import { TaskGroupPage } from "./pages/Tasks";
import { CodePage } from "./pages/Code";
import { MemoryPage } from "./pages/Memory";
import { ReviewsPage } from "./pages/Reviews";
import { RunPage, RunsPage } from "./pages/Runs";
import { SessionPage } from "./pages/Session";
import { SETTINGS_TABS, SettingsPage, type SettingsTab } from "./pages/Settings";
import { TerminalsPage } from "./pages/Terminals";
import { TodayPage } from "./pages/Today";
import { WorkflowPage } from "./pages/Workflows";
import { FlowRunPage, FlowsPage } from "./pages/Flows";
import { ReportScreen, SessionsScreen, TicketsScreen, UsageScreen, WeekScreen } from "./pages/Hubs";
import { listen } from "./lib/live";
import { show } from "./lib/notifications";
import { installPluginHost } from "./lib/pluginHost";
import type { Job } from "./lib/queries";
import type { Machine } from "@cockpit/shared";
import "./lib/theme";
import "./index.css";

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

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
  createRoute({ getParentRoute: () => root, path: "/", component: TodayPage }),
  createRoute({ getParentRoute: () => root, path: "/board", component: BoardPage, validateSearch: (s): { card?: string; filter?: "tasks" } => ({ card: str(s.card), filter: s.filter === "tasks" ? "tasks" : undefined }) }),
  moved("/tasks", "/board", { filter: "tasks" }),
  createRoute({ getParentRoute: () => root, path: "/tasks/$group", component: TaskGroupPage }),
  createRoute({ getParentRoute: () => root, path: "/sessions", component: SessionsScreen, validateSearch: (s): { tab?: "workflows" } => ({ tab: s.tab === "workflows" ? "workflows" : undefined }) }),
  createRoute({ getParentRoute: () => root, path: "/sessions/$id", component: SessionPage, validateSearch: (s): { agent?: string } => ({ agent: str(s.agent) }) }),
  moved("/workflows", "/sessions", { tab: "workflows" }),
  createRoute({ getParentRoute: () => root, path: "/workflows/$id", component: WorkflowPage }),
  createRoute({ getParentRoute: () => root, path: "/flows", component: FlowsPage }),
  createRoute({ getParentRoute: () => root, path: "/flows/$id", component: FlowRunPage }),
  createRoute({ getParentRoute: () => root, path: "/tickets", component: TicketsScreen, validateSearch: (s): { key?: string; tab?: "worktrees" } => ({ key: str(s.key), tab: s.tab === "worktrees" ? "worktrees" : undefined }) }),
  moved("/worktrees", "/tickets", { tab: "worktrees" }),
  createRoute({ getParentRoute: () => root, path: "/code", component: CodePage, validateSearch: (s): { root?: string; file?: string; diff?: boolean } => ({ root: str(s.root), file: str(s.file), diff: s.diff === true || s.diff === "1" || undefined }) }),
  createRoute({ getParentRoute: () => root, path: "/terminals", component: TerminalsPage, validateSearch: (s): { id?: string; resume?: string; pid?: number } => ({ id: str(s.id), resume: str(s.resume), pid: s.pid ? Number(s.pid) : undefined }) }),
  createRoute({ getParentRoute: () => root, path: "/memory", component: MemoryPage, validateSearch: (s): { path?: string } => ({ path: str(s.path) }) }),
  createRoute({ getParentRoute: () => root, path: "/usage", component: UsageScreen }),
  createRoute({ getParentRoute: () => root, path: "/weekly", component: WeekScreen, validateSearch: (s): { week?: string } => ({ week: str(s.week) }) }),
  createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsPage, validateSearch: (s): { tab?: SettingsTab } => ({ tab: SETTINGS_TABS.includes(s.tab as SettingsTab) ? (s.tab as SettingsTab) : undefined }) }),
  createRoute({ getParentRoute: () => root, path: "/runs", component: RunsPage, validateSearch: (s): { kind?: string; status?: string; ticket?: string; worktree?: string; group?: string; summary?: string } => ({ kind: str(s.kind), status: str(s.status), ticket: str(s.ticket), worktree: str(s.worktree), group: str(s.group), summary: str(s.summary) }) }),
  createRoute({ getParentRoute: () => root, path: "/runs/$id", component: RunPage }),
  createRoute({ getParentRoute: () => root, path: "/p/$plugin/$screen", component: PluginFrame }),
  createRoute({ getParentRoute: () => root, path: "/embed/terminal/$id", component: EmbedTerminal }),
  createRoute({ getParentRoute: () => root, path: "/reviews", component: ReviewsPage, validateSearch: (s): { id?: number; pr?: string } => ({ id: s.id ? Number(s.id) : undefined, pr: str(s.pr) }) }),
  createRoute({ getParentRoute: () => root, path: "/report", component: ReportScreen, validateSearch: (s): { sprint?: number; scope?: "me" } => ({ sprint: s.sprint ? Number(s.sprint) : undefined, scope: s.scope === "me" ? "me" : undefined }) }),
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

listen((ev) => {
  if (ev.type === "terms") queryClient.setQueryData(["terms"], ev.terms);
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
