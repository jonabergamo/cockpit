// Kinds of work: what a new worktree and its Claude session start with, picked by the ticket. A template matches a
// ticket's summary or type with a pattern; one with no pattern matches everything, so it works as the default
// when it comes last. Its vars fill placeholders in repo.createCommand, like {apps}.
import type { KitMember, KitTeam } from "@cockpit/shared";
import { readRow, writeRow, getSettings } from "./settings.ts";
import { agentBin, agentLaunch, agentProvider } from "./workers/index.ts";

export type WorkTemplate = ReturnType<typeof getSettings>["templates"][number];

const matches = (tpl: WorkTemplate, t: { summary?: string; type?: string }) => {
  if (!tpl.match.trim()) return true;
  try {
    const re = new RegExp(tpl.match, "i");
    return re.test(t.summary ?? "") || re.test(t.type ?? "");
  } catch {
    return false;
  }
};

export function templateFor(t: { summary?: string; type?: string }, id?: string, list = getSettings().templates): WorkTemplate | undefined {
  if (id) return list.find((x) => x.id === id);
  return list.find((x) => matches(x, t));
}

// the template's starting prompt for a ticket, or undefined when it has none
export function promptFor(tpl: WorkTemplate | undefined, t: { key?: string; url?: string; summary?: string }) {
  if (!tpl?.prompt.trim()) return undefined;
  const vars: Record<string, string> = { ticket: t.key ?? "", url: t.url ?? t.key ?? "", summary: t.summary ?? "" };
  return tpl.prompt.replace(/\{(ticket|url|summary)\}/g, (_, k: string) => vars[k]);
}

// which template a worktree was made with, so starting Claude in it later uses the same model and prompt
const rowKey = (path: string) => `worktree-template:${path}`;
export const rememberTemplate = (path: string, id: string) => writeRow(rowKey(path), id);
export const templateOf = (path: string) => {
  const id = readRow<string>(rowKey(path));
  return id ? templateFor({}, id) : undefined;
};

// claude's arguments for a template: its model, plan mode when it plans first, then the prompt
export const claudeArgs = (tpl: Pick<WorkTemplate, "model"> | undefined, prompt?: string, planFirst = false) => [
  ...(tpl?.model ? ["--model", tpl.model] : []),
  ...(planFirst ? ["--permission-mode", "plan"] : []),
  ...(prompt ? [prompt] : []),
];

// The team a kind sets a ticket up with: its own, or the usual pair, the agent planning first with its plan,
// changes and runs beside it, and a reviewer its turns go to once their checks pass, and back
export const DEFAULT_TEAM: KitTeam = {
  worktree: true,
  terms: [
    { id: "agent", name: "agent", prompt: "", planFirst: true, cards: ["plan", "changes", "runs"] },
    { id: "reviewer", name: "reviewer", prompt: "", planFirst: false, cards: [] },
  ],
  lines: [{ from: "agent", to: "reviewer", role: "review", both: true, limit: 4, when: "passing" }],
};
export const teamOf = (tpl?: WorkTemplate): KitTeam => (tpl?.team as KitTeam | undefined) ?? DEFAULT_TEAM;

// What starts one of a team's terminals for a ticket: its agent, model, plan mode and prompt (the main one's empty
// prompt takes the kind's). A plan first only means something to Claude; another agent just starts, and says so.
export function memberLaunch(tpl: WorkTemplate | undefined, member: KitMember, main: boolean, t: { key?: string; url?: string; summary?: string }) {
  const own = member.prompt.trim() ? promptFor({ ...(tpl ?? ({} as WorkTemplate)), prompt: member.prompt }, t) : undefined;
  const prompt = own ?? (main ? (promptFor(tpl, t) ?? t.url ?? t.key) : undefined);
  const other = member.agent && member.agent !== "claude" ? agentProvider(member.agent) : undefined;
  if (other?.terminal) return { command: agentBin(other), args: [...other.terminal(), ...(prompt ? (other.start?.(prompt) ?? [prompt]) : [])], planned: false };
  const model = member.model || tpl?.model;
  if (!member.agent || member.agent === "claude") return { command: "claude", args: claudeArgs({ model: model ?? "" }, prompt, member.planFirst), planned: member.planFirst };
  return { ...agentLaunch(prompt), planned: false };
}
