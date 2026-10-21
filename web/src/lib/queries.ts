import { useQuery } from "@tanstack/react-query";
import type { Epic, PullRequest, ScreenInfo, Sprint, Theme, Ticket, Worktree } from "@cockpit/shared";
import { api } from "./api";

export interface AppConfig {
  statusOrder: string[];
  releasedStatuses: string[];
  repoName: string;
  jira: boolean;
  github: boolean;
  demo: boolean;
  hidden: string[];
  screens: ScreenInfo[];
  themes: Theme[];
  // the plugins in use for these, null when none is on
  tracker: { plugin: string; name: string } | null;
  codeHost: { plugin: string; name: string } | null;
  verify: boolean;
  preview: boolean;
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
