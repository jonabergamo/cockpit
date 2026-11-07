import type { KitTeam } from "@cockpit/shared";

// Kinds of work ready to add and change: each with a team that suits it. Generic on purpose; a skill of your own
// goes in the prompt of the one you copy.
export interface ReadyKind {
  id: string;
  name: string;
  match: string;
  prompt: string;
  team: KitTeam;
}

export const READY_KINDS: ReadyKind[] = [
  {
    id: "feature",
    name: "Feature",
    match: "",
    prompt: "",
    team: {
      worktree: true,
      terms: [
        { id: "agent", name: "agent", prompt: "", planFirst: true, cards: ["plan", "changes", "runs"] },
        { id: "reviewer", name: "reviewer", prompt: "", planFirst: false, cards: [] },
      ],
      lines: [{ from: "agent", to: "reviewer", role: "review", both: true, limit: 4, when: "passing" }],
    },
  },
  {
    id: "bug",
    name: "Bug",
    match: "\\bbug\\b|\\bfix\\b|\\bbroken\\b",
    prompt: "Find out why {ticket} happens ({url}): reproduce it, find the cause, and plan the smallest fix. Don't fix it yourself.",
    team: {
      worktree: true,
      terms: [
        { id: "investigator", name: "investigator", prompt: "", planFirst: true, cards: ["plan"] },
        { id: "fixer", name: "fixer", prompt: "", planFirst: false, cards: ["changes", "runs"] },
        { id: "tester", name: "tester", prompt: "", planFirst: false, cards: ["runs"] },
      ],
      lines: [
        { from: "investigator", to: "fixer", role: "plan", both: false, limit: 2 },
        { from: "fixer", to: "tester", role: "custom", prompt: "Run the tests that cover this, and a check that the bug is gone. Say what fails and why.", both: true, limit: 4 },
      ],
    },
  },
  {
    id: "e2e",
    name: "E2E",
    match: "\\be2e\\b|end.to.end",
    prompt: "Write the end to end flows for {ticket} ({url}): one for each thing it says should work.",
    team: {
      worktree: true,
      terms: [
        { id: "author", name: "flow author", prompt: "", planFirst: true, cards: ["plan", "changes"] },
        { id: "runner", name: "runner", prompt: "", planFirst: false, cards: ["runs"] },
      ],
      lines: [{ from: "author", to: "runner", role: "custom", prompt: "Run these flows. Say which fail, with what each showed.", both: true, limit: 6 }],
    },
  },
  {
    id: "discovery",
    name: "Discovery",
    match: "discovery|spike|investigat",
    prompt: "Work out what {ticket} needs ({url}): what's there today, the options, and a breakdown into tickets. Write no code.",
    team: {
      worktree: false,
      terms: [
        { id: "researcher", name: "researcher", prompt: "", planFirst: true, cards: ["plan"] },
        { id: "critic", name: "critic", prompt: "", planFirst: false, cards: [] },
      ],
      lines: [{ from: "researcher", to: "critic", role: "review", both: true, limit: 3 }],
    },
  },
];

// the team as a line of text: "investigator → fixer ↔ tester"
export function teamText(t: KitTeam) {
  const name = (id: string) => t.terms.find((m) => m.id === id)?.name ?? id;
  if (!t.lines.length) return t.terms.map((m) => m.name).join(", ");
  return t.lines.map((l) => `${name(l.from)} ${l.both ? "↔" : "→"} ${name(l.to)}`).join(", ");
}
