// What a Claude session is working through: the plan it last had approved (plan mode's ExitPlanMode), its to-do
// list when it keeps one (TodoWrite, or the TaskCreate/TaskUpdate tools), and what it's doing right now, from its
// last few tool calls. A transcript only grows, so each file is read on from where the last look stopped.
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Entry, SessionPlan, PlanStep } from "@cockpit/shared";
import { sessionFile } from "./claude/sessions.ts";
import { parseLine } from "./claude/transcript.ts";

type State = {
  offset: number;
  plan?: { text: string; at: string; id: string; approved?: boolean };
  todos?: PlanStep[];
  tasks: Map<string, PlanStep & { n: number }>;
  doing: { id: string; at: string; what: string; done: boolean }[];
};

const states = new Map<string, State>();
const CHUNK = 4 * 1024 * 1024;
// the lines worth parsing: a plan, a to-do list, any tool call or its result
const WANTED = /"tool_use"|"tool_result"/;

const short = (s: string, n = 80) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

// a tool call in a few words: "Editing TermCanvas.tsx", "Running: pnpm build"
export function describe(name: string, input: any): string {
  const file = (p?: string) => (p ? basename(p) : "a file");
  switch (name) {
    case "Bash":
      return input?.description ? short(input.description) : `Running ${short(String(input?.command ?? ""), 60)}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${file(input?.file_path)}`;
    case "Write":
      return `Writing ${file(input?.file_path)}`;
    case "Read":
      return `Reading ${file(input?.file_path)}`;
    case "NotebookEdit":
      return `Editing ${file(input?.notebook_path)}`;
    case "Grep":
      return `Searching for ${short(String(input?.pattern ?? ""), 50)}`;
    case "Glob":
      return `Looking for ${short(String(input?.pattern ?? ""), 50)}`;
    case "Agent":
    case "Task":
      return `Agent: ${short(String(input?.description ?? input?.prompt ?? ""), 60)}`;
    case "Skill":
      return `Skill ${input?.skill ?? ""}`;
    case "WebSearch":
      return `Searching the web for ${short(String(input?.query ?? ""), 50)}`;
    case "WebFetch":
      return `Reading ${short(String(input?.url ?? ""), 60)}`;
    case "ExitPlanMode":
      return "Asking to go ahead with the plan";
    case "AskUserQuestion":
      return "Asking you a question";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return "Updating its to-do list";
    default:
      return name.startsWith("mcp__") ? name.split("__").slice(1).join(" ") : name;
  }
}

const status = (s: unknown): PlanStep["status"] => (s === "completed" ? "done" : s === "in_progress" ? "doing" : "todo");

function take(st: State, e: Entry) {
  if (e.kind === "tool") {
    const input = e.input as any;
    if (e.name === "ExitPlanMode" && typeof input?.plan === "string") st.plan = { text: input.plan, at: e.ts, id: e.toolUseId };
    if (e.name === "TodoWrite" && Array.isArray(input?.todos)) st.todos = input.todos.map((t: any) => ({ text: String(t.content ?? t.activeForm ?? ""), status: status(t.status) }));
    if (e.name === "TaskCreate" && input?.subject) {
      // its id comes back in the result; until then it's known by the call
      st.tasks.set(e.toolUseId, { text: String(input.subject), status: "todo", n: st.tasks.size });
    }
    if (e.name === "TaskUpdate" && input?.taskId) {
      const t = [...st.tasks.entries()].find(([k]) => k === `task:${input.taskId}`)?.[1];
      if (t) {
        if (input.status === "deleted") st.tasks.delete(`task:${input.taskId}`);
        else {
          if (input.status) t.status = status(input.status);
          if (input.subject) t.text = String(input.subject);
        }
      }
    }
    st.doing.push({ id: e.toolUseId, at: e.ts, what: describe(e.name, input), done: false });
    if (st.doing.length > 12) st.doing.shift();
  }
  if (e.kind === "tool_result") {
    const d = st.doing.find((x) => x.id === e.toolUseId);
    if (d) d.done = true;
    if (st.plan?.id === e.toolUseId) st.plan.approved = !e.isError;
    // "Task #3 created successfully: …": the call's task gets its real id
    const made = st.tasks.get(e.toolUseId);
    const m = e.text.match(/Task #?(\w+)/);
    if (made && m) {
      st.tasks.delete(e.toolUseId);
      st.tasks.set(`task:${m[1]}`, made);
    }
  }
}

async function scan(file: string) {
  let st = states.get(file);
  const { size } = await stat(file);
  // a file that shrank was rewritten: start again
  if (!st || size < st.offset) st = { offset: 0, tasks: new Map(), doing: [] };
  states.set(file, st);
  if (size === st.offset) return st;
  const fh = await open(file, "r");
  try {
    while (st.offset < size) {
      const len = Math.min(CHUNK, size - st.offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.offset);
      const end = buf.lastIndexOf(10);
      // a line longer than a chunk: skip past it
      if (end < 0) {
        if (len < CHUNK) break;
        st.offset += len;
        continue;
      }
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) if (WANTED.test(line)) for (const e of parseLine(line)) take(st, e);
      st.offset += end + 1;
    }
  } finally {
    await fh.close();
  }
  return st;
}

// The steps of a plan written in markdown. Plans tend to go: some context, the parts of the work, the files, how
// it's checked. So: the list under a heading that says it's the steps, or else a numbered list (a sequence), or
// else its section headings less the ones every plan has, or else its top-level list.
const AROUND = /^(context|background|why|problem|goal|goals|summary|overview|files|files to change|critical files|notes|risks|open questions|out of scope|non-goals)\b/i;
const CHECK = /^(verification|verify|verifying|testing|tests?|test plan|how to (test|check|verify)|how it's (checked|tested)|checking|checks?)\b/i;
const STEPS = /^(steps|plan|implementation|approach|changes|what changes|the work|order|sequence)\b/i;
const clean = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
export function stepsOf(text: string): string[] {
  const lines = text.split("\n");
  const item = (l: string, numbered: boolean) => l.match(numbered ? /^\s{0,1}\d+[.)]\s+(?:\[[ xX]\]\s+)?(.+)/ : /^\s{0,1}[-*+]\s+(?:\[[ xX]\]\s+)?(.+)/)?.[1];
  const heading = (l: string) => l.match(/^(#{1,4})\s+(.+)/);
  const done = (xs: (string | undefined)[]) => xs.filter((s): s is string => !!s).map(clean).filter(Boolean).slice(0, 40);
  // a section that says it's the steps: its list
  for (let i = 0; i < lines.length; i++) {
    const h = heading(lines[i]);
    if (!h || !STEPS.test(clean(h[2]))) continue;
    const end = lines.findIndex((l, j) => j > i && (heading(l)?.[1].length ?? 9) <= h[1].length);
    const body = lines.slice(i + 1, end < 0 ? undefined : end);
    const got = done(body.map((l) => item(l, true) ?? item(l, false)));
    if (got.length >= 2) return got;
    const subs = done(body.map((l) => heading(l)?.[2]));
    if (subs.length >= 2) return subs;
  }
  // the lists outside the context, the files and how it's checked
  let skip = false;
  const work = lines.filter((l) => {
    const h = heading(l);
    if (h) skip = AROUND.test(clean(h[2])) || CHECK.test(clean(h[2]));
    return !skip;
  });
  const numbered = done(work.map((l) => item(l, true)));
  if (numbered.length >= 2) return numbered;
  const sections = done(lines.map((l) => heading(l)).filter((h) => h && h[1].length >= 2 && !AROUND.test(clean(h[2]))).map((h) => h![2]));
  if (sections.length >= 2) return sections;
  return done(work.map((l) => item(l, false)));
}

export async function planOf(sessionId: string): Promise<SessionPlan> {
  const file = sessionFile(sessionId);
  if (!file) return { doing: [] };
  const st = await scan(file).catch(() => undefined);
  if (!st) return { doing: [] };
  const tasks = [...st.tasks.values()].sort((a, b) => a.n - b.n).map(({ n: _, ...t }) => t);
  return {
    plan: st.plan && { text: st.plan.text, at: st.plan.at, approved: st.plan.approved, steps: stepsOf(st.plan.text) },
    todos: tasks.length ? tasks : st.todos,
    doing: st.doing.slice(-6).reverse().map(({ id: _, ...d }) => d),
  };
}
