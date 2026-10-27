import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { Fonts } from "./fonts";
import { usd } from "./format";

export type CostMode = "auto" | "real" | "api" | "hide";
export interface Billing {
  kind: "subscription" | "api" | "unknown";
  why: string;
}
export interface SettingsRes {
  settings: {
    costs: CostMode;
    hidden: string[];
    fonts: Fonts;
    autopilot: { maxAttempts: number; onByDefault: boolean };
    tasks: { maxParallel: number; pauseAbovePct: number; defaultModel: string; defaultAgent: string };
    verify: { auto: boolean };
    updates: { auto: boolean };
    pipeline: { openPrompt: string; reviewPrompt: string; noCodePattern: string; mainBranches: string };
    alerts: { stuckMinutes: number; escalateMinutes: number };
    away: { minutes: number };
    budget: { perTicketUSD: number; perTicketMTokens: number; warnPct: number };
    weekly: { on: boolean; day: number; hour: number };
    templates: { id: string; name: string; match: string; vars: Record<string, string>; model: string; prompt: string; autopilot: "default" | "on" | "off" }[];
    notes: { prompt: string; maxChars: number; liveBranch: string };
    agents: { off: string[] };
    ci: { local: string[] };
    overnight: { capUSD: number; capMTokens: number; fromHour: number; toHour: number };
  };
  billing: Billing;
}

export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsRes>("/settings"), staleTime: 5 * 60_000 });

export function useSaveSettings() {
  const qc = useQueryClient();
  return async (patch: Partial<SettingsRes["settings"]>) => qc.setQueryData(["settings"], await api.put<SettingsRes>("/settings", patch));
}

// The dollars Claude Code reports are priced at API rates. On a plan that is only a comparison, so it says
// "API value"; on an API key it is the bill, so it says "Cost". Hidden takes the amounts off every page.
export function useCost() {
  const q = useSettings();
  const mode = q.data?.settings.costs ?? "auto";
  const real = mode === "real" || (mode === "auto" && q.data?.billing.kind === "api");
  const hidden = mode === "hide";
  return {
    hidden,
    real,
    label: real ? "Cost" : "API value",
    hint: real ? "What Claude Code reports these tokens cost" : "What these tokens would cost on the API. Your plan doesn't charge this",
    fmt: (n?: number) => (hidden ? "" : usd(n)),
  };
}
