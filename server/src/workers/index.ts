// The coding agents cockpit can hand work to: the ones that ship with it, and any a plugin adds with k.agent
import type { AgentInfo, AgentProvider } from "@cockpit/shared";
import { config } from "../config.ts";
import { getSettings } from "../settings.ts";
import { run } from "../util.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { gemini } from "./gemini.ts";

const builtIn = [claude, codex, gemini];
let extra: () => AgentProvider[] = () => [];
export const useExtraAgents = (fn: () => AgentProvider[]) => void (extra = fn);

export const agentProviders = () => [...builtIn, ...extra().filter((p) => !builtIn.some((b) => b.id === p.id))];
export const agentProvider = (id: string) => agentProviders().find((p) => p.id === id);

// turned off in Settings; Claude Code stays, since it's what everything falls back to
export const agentOff = (id: string) => id !== "claude" && getSettings().agents.off.includes(id);

export function agentBin(p: AgentProvider) {
  if (p.id === "claude") return config.agents.claude?.bin || config.claude.bin;
  return config.agents[p.id]?.bin || p.bin;
}

// whether it's installed and which version, asked of a login shell (where fnm, nvm and the like put them) and kept
// for a few minutes
const seen = new Map<string, { at: number; version?: string }>();
async function versionOf(p: AgentProvider) {
  const known = seen.get(p.id);
  if (known && Date.now() - known.at < 5 * 60_000) return known.version;
  const out = await run("bash", ["-lc", 'exec "$@" --version', "bash", agentBin(p)], { timeout: 15_000 }).catch(() => undefined);
  const version = out?.trim().split("\n")[0] || undefined;
  seen.set(p.id, { at: Date.now(), version });
  return version;
}

export async function agentInfo(p: AgentProvider): Promise<AgentInfo> {
  const version = await versionOf(p);
  return { id: p.id, name: p.name, about: p.about, installed: !!version, enabled: !agentOff(p.id), version, models: (await Promise.resolve(p.models?.() ?? []).catch(() => [])) ?? [], terminal: !!p.terminal };
}

export const listAgents = () => Promise.all(agentProviders().map(agentInfo));
