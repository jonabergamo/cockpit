import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "./components/Layout";
import { EmbedTerminal } from "./components/EmbedTerminal";
import { PluginFrame } from "./components/PluginFrame";
import { BoardPage } from "./pages/Board";
import { TaskGroupPage, TasksPage } from "./pages/Tasks";
import { CodePage } from "./pages/Code";
import { MemoryPage } from "./pages/Memory";
import { ReportPage } from "./pages/Report";
import { ReviewsPage } from "./pages/Reviews";
import { SessionPage } from "./pages/Session";
import { SessionsPage } from "./pages/Sessions";
import { SettingsPage } from "./pages/Settings";
import { TerminalsPage } from "./pages/Terminals";
import { TicketsPage } from "./pages/Tickets";
import { TodayPage } from "./pages/Today";
import { UsagePage } from "./pages/Usage";
import { WorkflowPage, WorkflowsPage } from "./pages/Workflows";
import { WorktreesPage } from "./pages/Worktrees";
import { listen } from "./lib/live";
import { show } from "./lib/notifications";
import { installPluginHost } from "./lib/pluginHost";
import type { Job } from "./lib/queries";
import "./lib/theme";
import "./index.css";

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const root = createRootRoute({ component: Layout });

const routes = [
  createRoute({ getParentRoute: () => root, path: "/", component: TodayPage }),
  createRoute({ getParentRoute: () => root, path: "/board", component: BoardPage, validateSearch: (s): { card?: string } => ({ card: str(s.card) }) }),
  createRoute({ getParentRoute: () => root, path: "/tasks", component: TasksPage }),
  createRoute({ getParentRoute: () => root, path: "/tasks/$group", component: TaskGroupPage }),
  createRoute({ getParentRoute: () => root, path: "/sessions", component: SessionsPage }),
  createRoute({ getParentRoute: () => root, path: "/sessions/$id", component: SessionPage, validateSearch: (s): { agent?: string } => ({ agent: str(s.agent) }) }),
  createRoute({ getParentRoute: () => root, path: "/workflows", component: WorkflowsPage }),
  createRoute({ getParentRoute: () => root, path: "/workflows/$id", component: WorkflowPage }),
  createRoute({ getParentRoute: () => root, path: "/tickets", component: TicketsPage, validateSearch: (s): { key?: string } => ({ key: str(s.key) }) }),
  createRoute({ getParentRoute: () => root, path: "/worktrees", component: WorktreesPage }),
  createRoute({ getParentRoute: () => root, path: "/code", component: CodePage, validateSearch: (s): { root?: string; file?: string; diff?: boolean } => ({ root: str(s.root), file: str(s.file), diff: s.diff === true || s.diff === "1" || undefined }) }),
  createRoute({ getParentRoute: () => root, path: "/terminals", component: TerminalsPage, validateSearch: (s): { id?: string; resume?: string; pid?: number } => ({ id: str(s.id), resume: str(s.resume), pid: s.pid ? Number(s.pid) : undefined }) }),
  createRoute({ getParentRoute: () => root, path: "/memory", component: MemoryPage, validateSearch: (s): { path?: string } => ({ path: str(s.path) }) }),
  createRoute({ getParentRoute: () => root, path: "/usage", component: UsagePage }),
  createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsPage }),
  createRoute({ getParentRoute: () => root, path: "/p/$plugin/$screen", component: PluginFrame }),
  createRoute({ getParentRoute: () => root, path: "/embed/terminal/$id", component: EmbedTerminal }),
  createRoute({ getParentRoute: () => root, path: "/reviews", component: ReviewsPage, validateSearch: (s): { id?: number; pr?: string } => ({ id: s.id ? Number(s.id) : undefined, pr: str(s.pr) }) }),
  createRoute({ getParentRoute: () => root, path: "/report", component: ReportPage, validateSearch: (s): { sprint?: number; scope?: "me" } => ({ sprint: s.sprint ? Number(s.sprint) : undefined, scope: s.scope === "me" ? "me" : undefined }) }),
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
  if (ev.type === "plugins") queryClient.invalidateQueries({ queryKey: ["config"] }), queryClient.invalidateQueries({ queryKey: ["plugins"] });
  if (ev.type === "notify") show(ev, (link) => router.history.push(link));
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
