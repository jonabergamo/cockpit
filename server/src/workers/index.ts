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

// whether it's logged in, asked the same way and kept for a minute, since logging in happens in a terminal
const authSeen = new Map<string, { at: number; authed?: boolean }>();
async function authedOf(p: AgentProvider) {
  if (!p.authed) return;
  const known = authSeen.get(p.id);
  if (known && Date.now() - known.at < 60_000) return known.authed;
  const authed = await run("bash", ["-lc", 'exec "$@"', "bash", agentBin(p), ...p.authed], { timeout: 15_000 }).then(
    () => true,
    () => false,
  );
  authSeen.set(p.id, { at: Date.now(), authed });
  return authed;
}

export async function agentInfo(p: AgentProvider): Promise<AgentInfo> {
  const version = await versionOf(p);
  const authed = version ? await authedOf(p) : undefined;
  return { id: p.id, name: p.name, about: p.about, installed: !!version, enabled: !agentOff(p.id), version, authed, models: (await Promise.resolve(p.models?.() ?? []).catch(() => [])) ?? [], terminal: !!p.terminal };
}

// The main coding agent, from Settings → Board and automation; undefined is Claude Code, which everything that
// opens an agent did before there were others
export function mainAgent(): AgentProvider | undefined {
  const id = getSettings().tasks.defaultAgent;
  const p = id && id !== "claude" ? agentProvider(id) : undefined;
  return p && !agentOff(p.id) ? p : undefined;
}
export const mainAgentName = () => mainAgent()?.name ?? "Claude";

// A skill called the way Claude Code does it, "/name what to do", put the way other agents take it: they find
// skills by name in what they're asked
export function forAgent(p: AgentProvider | undefined, prompt: string) {
  if (!p) return prompt;
  const m = prompt.match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/);
  return m ? `Use the ${m[1]} skill.${m[2] ? ` ${m[2]}` : ""}` : prompt;
}

// What opens the main agent's own screen in a terminal, with a first prompt. On Claude Code, claudeArgs (resume,
// a system prompt...) when given; other agents start a new conversation with the prompt.
export function agentLaunch(prompt?: string, claudeArgs?: string[]): { command: string; args: string[]; agent?: AgentProvider } {
  const p = mainAgent();
  if (!p?.terminal) return { command: "claude", args: claudeArgs ?? (prompt ? [prompt] : []) };
  const first = prompt ? forAgent(p, prompt) : undefined;
  return { command: agentBin(p), args: [...p.terminal(), ...(first ? (p.start?.(first) ?? [first]) : [])], agent: p };
}

export const listAgents = () => Promise.all(agentProviders().map(agentInfo));
