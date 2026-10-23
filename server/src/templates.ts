// Kinds of work: what a new worktree and its Claude session start with, picked by the ticket. A template matches a
// ticket's summary or type with a pattern; one with no pattern matches everything, so it works as the default
// when it comes last. Its vars fill placeholders in repo.createCommand, like {apps}.
import { readRow, writeRow, getSettings } from "./settings.ts";

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

// claude's arguments for a template: its model, then the prompt
export const claudeArgs = (tpl: WorkTemplate | undefined, prompt?: string) => [...(tpl?.model ? ["--model", tpl.model] : []), ...(prompt ? [prompt] : [])];
