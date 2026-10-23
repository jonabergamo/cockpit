import { useQuery } from "@tanstack/react-query";
import type { Epic, PullRequest, Run, RunDetail, RunKind, RunStatus, ScreenInfo, Sprint, Theme, Ticket, Worktree } from "@cockpit/shared";
import { api, qs } from "./api";

export interface AppConfig {
  statusOrder: string[];
  releasedStatuses: string[];
  repoName: string;
  repo?: { path: string; state: "unset" | "missing" | "not-git" | "ok" };
  jira: boolean;
  github: boolean;
  demo: boolean;
  hidden: string[];
  screens: ScreenInfo[];
  moved?: { plugin: string; id: string; to: string }[];
  themes: Theme[];
  // the plugins in use for these, null when none is on
  tracker: { plugin: string; name: string } | null;
  codeHost: { plugin: string; name: string } | null;
  verify: boolean;
  preview: boolean;
  openCommand?: string;
  reviewBackend?: boolean;
  createVars: string[];
}

export interface TicketsRes {
  sprint?: Sprint;
  tickets: Ticket[];
  epics?: Epic[];
}

export interface Job {
  id: string;
  label: string;
  command: string;
  startedAt: number;
  output: string;
  code?: number;
}

export const useAppConfig = () => useQuery({ queryKey: ["config"], queryFn: () => api.get<AppConfig>("/config"), staleTime: Infinity });

// only asked for while a code host or tracker plugin is on
export function usePrs() {
  const cfg = useAppConfig();
  return useQuery({ queryKey: ["prs"], queryFn: () => api.get<{ mine: PullRequest[]; review: PullRequest[] }>("/prs"), enabled: !!cfg.data?.codeHost });
}

export function useTickets() {
  const cfg = useAppConfig();
  return useQuery({ queryKey: ["tickets"], queryFn: () => api.get<TicketsRes>("/tickets"), enabled: !!cfg.data?.tracker });
}

export const useWorktrees = () => useQuery({ queryKey: ["worktrees"], queryFn: () => api.get<Worktree[]>("/worktrees") });

// Job output streams over the socket and is patched in once, in main.tsx, however many views show it.
export const useJobs = () => useQuery({ queryKey: ["jobs"], queryFn: () => api.get<Job[]>("/jobs") });

// Runs come back fresh whenever one changes: main.tsx refetches them on the socket's "run" event.
export interface RunsFilter {
  kind?: RunKind;
  status?: RunStatus;
  ticket?: string;
  worktree?: string;
  limit?: number;
}
export const useRuns = (f: RunsFilter = {}) => useQuery({ queryKey: ["runs", f], queryFn: () => api.get<Run[]>(`/runs${qs({ ...f })}`) });
export const useRun = (id: string) =>
  useQuery({ queryKey: ["run", id], queryFn: () => api.get<RunDetail>(`/runs/${encodeURIComponent(id)}?lines=400`), refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false) });
