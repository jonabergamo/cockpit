// Additional notes for a sprint: everything the report has collected, written up by Claude for people outside
// the team. Only runs when you ask, since it's a long claude -p call.
import { listSessions } from "./claude/sessions.ts";
import { config } from "./config.ts";
import { startJob } from "./jobs.ts";
import { myPrs } from "./providers.ts";
import { activity, sprintReport } from "./report.ts";
import { getSettings, readRow, writeRow } from "./settings.ts";
import { day, fill, run } from "./util.ts";

export const DEFAULT_NOTES_PROMPT = `Write the additional notes for this sprint's update. People outside the engineering team read them, such as customer service and leadership, so use plain language and say what changed for users or the business, not how the tickets moved.

Give each person with tickets in the sprint their own section, then finish with a Team section for what the team did together and anything blocked or at risk. Use only the data below. Don't invent progress, dates or reasons, and leave out anything the data doesn't make clear. Write plain text ready to paste, and only mention ticket keys where they help.`;

// whatever the instructions say, the page wants the notes alone
const OUTPUT_RULE = "Reply with the notes only: no preamble, no code fences and nothing after them, like what you left out or why.";

// Claude sometimes still wraps the notes in a fence and explains itself around it; keep only the notes.
export function notesOnly(output: string) {
  const text = output
    .split("\n")
    .filter((l) => !/^Warning: no stdin data received/.test(l))
    .join("\n")
    .trim();
  const fenced = text.match(/```[a-z]*\n([\s\S]*?)\n```/);
  return (fenced ? fenced[1] : text).trim();
}

// When each ticket's work reached the production branch, from the commit subjects in its history (merge commits
// name the branch, squash merges the PR), and whether a revert took it out again. Bodies are left out: a merge's
// body is the PR title, where a typo'd key would credit the wrong ticket.
export function reachedLive(log: string, keys: string[]) {
  const out = new Map<string, { at: string; reverted: boolean }>();
  // newest first, as git log prints it
  for (const line of log.split("\n").reverse()) {
    const [at, ...rest] = line.split("\t");
    const text = rest.join(" ");
    if (!at || !text) continue;
    for (const key of keys) {
      if (!new RegExp(`\\b${key}\\b`, "i").test(text)) continue;
      if (/\brevert/i.test(text)) {
        const seen = out.get(key);
        if (seen) seen.reverted = true;
      } else out.set(key, { at: at.slice(0, 10), reverted: false });
    }
  }
  return out;
}

async function liveLog(branch: string, since: string) {
  if (!branch || !config.repo.path) return "";
  await run("git", ["-C", config.repo.path, "fetch", "origin", branch, "--quiet"], { timeout: 60_000 }).catch(() => "");
  return run("git", ["-C", config.repo.path, "log", `origin/${branch}`, `--since=${since}`, "--format=%cI%x09%s"], { timeout: 60_000 }).catch(() => "");
}

const days = (ms: number) => {
  const d = ms / 864e5;
  return d < 1 ? `${Math.max(1, Math.round(d * 24))}h` : `${d.toFixed(d < 10 ? 1 : 0)}d`;
};

// The data as plain text, the way Claude reads it best: the sprint, each person, each ticket with its history,
// then what happened day by day.
export async function sprintBrief(sprintId?: number) {
  const r = await sprintReport(sprintId, "team");
  if (!r) throw Object.assign(new Error("no sprint to write notes for"), { status: 404 });
  const { sprint, totals } = r;
  const from = sprint.start ? day(new Date(sprint.start)) : day(Date.now() - 13 * 864e5);
  const to = day(sprint.end && Date.parse(sprint.end) < Date.now() ? new Date(sprint.end) : new Date());
  const branch = getSettings().notes.liveBranch.trim();
  // a ticket can carry over many sprints, and a fix can land months before the ticket is closed
  const since = day(new Date(Date.parse(from) - 365 * 864e5));
  const [acts, prs, log] = await Promise.all([activity(from, to), myPrs().catch(() => []), liveLog(branch, since)]);
  const live = reachedLive(log, r.tickets.map((t) => t.key));
  const sessions = listSessions({ limit: 5000 });
  const summary = new Map(r.tickets.map((t) => [t.key, t.summary]));
  const label = (key: string) => (summary.has(key) ? `${key} (${summary.get(key)})` : key);

  const out: string[] = [];
  out.push(`Sprint: ${sprint.name}${sprint.start ? `, ${day(new Date(sprint.start))} to ${sprint.end ? day(new Date(sprint.end)) : "?"}` : ""}`);
  if (sprint.goal) out.push(`Goal: ${sprint.goal}`);
  out.push(`${totals.daysLeft} of ${totals.daysTotal} working days left.`);
  out.push(`Points: ${totals.scope} in the sprint, ${totals.done} done, ${totals.released} released, ${totals.projected} projected by the end at the current pace.`);
  const byStatus = Object.entries(totals.byStatus).filter(([, n]) => n);
  if (byStatus.length) out.push(`Points by status: ${byStatus.map(([s, n]) => `${s} ${n}`).join(", ")}.`);
  const late = r.tickets.filter((t) => t.addedLate);
  if (late.length) out.push(`Added after the sprint started: ${late.map((t) => t.key).join(", ")}.`);
  if (branch) out.push(`Production is the ${branch} branch. Each ticket says whether its work has reached ${branch}; work that hasn't is not in production yet, whatever its status.`);

  out.push("", "People");
  for (const p of r.people) out.push(`- ${p.name}: ${p.tickets} tickets, ${p.scope} points, ${p.done} of them done`);
  const me = r.people.find((p) => p.me)?.name;
  // the tracker covers everyone, but PRs, commits and Claude sessions come from this machine's account
  out.push(`The tickets and status changes cover the whole team. PRs, commits and Claude sessions are only ${me ? `${me}'s` : "the person running this"}, so don't read others' work from their absence.`);

  // the epics behind the sprint: a project ships when its epic is done, not when one of its tickets is
  const epics = new Map<string, { title?: string; status?: string; type?: string; people: Map<string, string[]> }>();
  for (const t of r.tickets) {
    if (!t.parent) continue;
    const e = epics.get(t.parent) ?? { title: t.parentSummary, status: t.parentStatus, type: t.parentType, people: new Map() };
    const who = t.assignee ?? "nobody";
    e.people.set(who, [...(e.people.get(who) ?? []), t.status]);
    epics.set(t.parent, e);
  }
  if (epics.size) {
    out.push("", "Epics in this sprint");
    for (const [key, e] of [...epics].sort((a, b) => b[1].people.size - a[1].people.size)) {
      const who = [...e.people].map(([name, statuses]) => `${name} ${statuses.length} (${statuses.join(", ")})`).join("; ");
      out.push(`- ${key}${e.title ? ` ${e.title}` : ""}${e.type ? ` [${e.type}]` : ""}: ${e.status ?? "status unknown"}. Tickets: ${who}`);
    }
  }

  out.push("", "Tickets");
  const now = Date.now();
  for (const t of [...r.tickets].sort((a, b) => (a.assignee ?? "").localeCompare(b.assignee ?? "") || a.key.localeCompare(b.key))) {
    const meta = [t.type, t.points !== undefined ? `${t.points} pts` : undefined, t.priority].filter(Boolean).join(", ");
    out.push(`- ${t.key}${meta ? ` [${meta}]` : ""} ${t.summary}`);
    const facts = [`assignee ${t.assignee ?? "nobody"}`, `status ${t.status}`];
    // the epic it's part of is what shows two people working on the same thing
    const title = t.parentSummary ?? (t.parent ? summary.get(t.parent) : undefined);
    if (t.parent) facts.push(`part of ${t.parent}${title ? ` (${title})` : ""}${t.parentStatus ? `, ${t.parentType?.toLowerCase() ?? "parent"} ${t.parentStatus}` : ""}`);
    else if (t.epic) facts.push(`epic ${label(t.epic)}`);
    if (t.addedLate) facts.push("added late");
    if (branch) {
      const l = live.get(t.key);
      facts.push(!l ? `not on ${branch} yet` : l.reverted ? `reached ${branch} ${l.at}, then reverted` : `on ${branch} since ${l.at}`);
    }
    out.push(`  ${facts.join(" · ")}`);
    // how long it sat in each status, so "stuck in review for a week" is visible
    const time = new Map<string, number>();
    for (const s of t.spans) time.set(s.status, (time.get(s.status) ?? 0) + ((s.to ? Date.parse(s.to) : now) - Date.parse(s.from)));
    if (time.size) out.push(`  time in status: ${[...time].map(([s, ms]) => `${s} ${days(ms)}`).join(", ")}`);
    for (const p of prs.filter((p) => p.ticket === t.key)) out.push(`  PR #${p.number} ${p.title}: ${p.state.toLowerCase()}${p.checks ? `, checks ${p.checks}` : ""}${p.reviewDecision ? `, ${p.reviewDecision.toLowerCase().replace(/_/g, " ")}` : ""}`);
    const worked = sessions.filter((s) => s.ticket === t.key && s.title).map((s) => s.title!);
    if (worked.length) out.push(`  worked on with Claude: ${[...new Set(worked)].slice(0, 6).join("; ")}`);
  }

  out.push("", "Day by day");
  for (const d of [...acts].reverse()) {
    const lines = [
      ...d.transitions.map((x) => `${label(x.key)} moved ${x.from ? `from ${x.from} ` : ""}to ${x.to}`),
      ...d.prsMerged.map((p) => `merged PR #${p.number} ${p.title}`),
      ...d.prsOpened.map((p) => `opened PR #${p.number} ${p.title}`),
      ...d.commits.map((c) => `commit: ${c.subject}`),
    ];
    if (lines.length) out.push(`${d.date}`, ...lines.map((l) => `- ${l}`));
  }
  return { sprint, text: out.join("\n") };
}

export interface SavedNotes {
  text: string;
  at: number;
  ok: boolean;
}

const running = new Map<number, string>();
const rowKey = (id: number) => `sprint-notes:${id}`;

export function savedNotes(sprintId: number) {
  return { saved: readRow<SavedNotes>(rowKey(sprintId)), jobId: running.get(sprintId) };
}

const claude = (label: string, prompt: string, onDone: (out: string, ok: boolean) => void) =>
  // stdin closed, or claude waits a few seconds for piped input and warns about it in the output
  // in the repo, which Claude already trusts; the home folder usually isn't
  startJob(label, `${fill("claude -p {prompt}", { prompt })} < /dev/null`, config.repo.path || process.env.HOME, (j) => onDone(notesOnly(j.output), j.code === 0));

const lengthRule = (max: number) => `The whole reply must be ${max} characters or fewer, spaces and newlines included. Count before you answer and cut the least important items until it fits.`;

// One run per sprint at a time; the result is kept, so the page shows it again later without running Claude.
// With a length limit, a draft that comes back too long goes back to Claude to shorten, up to twice.
export async function generateNotes(sprintId?: number) {
  const { sprint, text } = await sprintBrief(sprintId);
  const busy = running.get(sprint.id);
  if (busy) return { jobId: busy, sprintId: sprint.id };
  const { prompt: custom, maxChars } = getSettings().notes;
  const instructions = custom.trim() || DEFAULT_NOTES_PROMPT;
  const rules = [OUTPUT_RULE, maxChars ? lengthRule(maxChars) : ""].filter(Boolean).join(" ");
  const label = `sprint notes · ${sprint.name}`;

  const finish = (notes: string, tries: number) => {
    if (!maxChars || notes.length <= maxChars || tries >= 2) {
      running.delete(sprint.id);
      writeRow(rowKey(sprint.id), { text: notes, at: Date.now(), ok: true } satisfies SavedNotes);
      return;
    }
    const shorten = `These notes are ${notes.length} characters. Shorten them to ${maxChars} characters or fewer, spaces and newlines included. Keep the same sections and the most important items, drop the rest. Don't add anything new. ${OUTPUT_RULE}\n\n${notes}`;
    const job = claude(`${label} · shorten`, shorten, (out, ok) => (ok && out ? finish(out, tries + 1) : finish(notes, 2)));
    running.set(sprint.id, job.id);
  };

  const job = claude(label, `${instructions}\n\n${rules}\n\n---\n\n${text}`, (notes, ok) => {
    if (ok && notes) finish(notes, 0);
    else running.delete(sprint.id);
  });
  running.set(sprint.id, job.id);
  return { jobId: job.id, sprintId: sprint.id };
}
