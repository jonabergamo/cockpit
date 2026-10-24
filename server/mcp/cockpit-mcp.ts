// Cockpit's tools for Claude Code, over MCP on stdio. A lead session uses them to see every worker, queue tasks,
// answer workers and follow their PRs. Every tool is a thin call to the cockpit server on this machine.
//   claude mcp add --scope user cockpit -- <tsx> <this file>
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.COCKPIT_URL ?? "http://127.0.0.1:8770").replace(/\/$/, "");

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const out = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }] });
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    return out(await fn(a));
  } catch (e) {
    return { ...out(`cockpit: ${(e as Error).message}`), isError: true };
  }
};

interface Card {
  id: string;
  kind: string;
  title: string;
  ticket?: string;
  folder: string;
  path?: string;
  branch?: string;
  column: string;
  reason: string;
  session?: { id: string; status: string };
  pr?: { number: number; url: string; state: string; checks?: string; review?: string };
  verify?: { state: string };
  autopilot?: { on: boolean; attempts: number; gaveUp: boolean };
  task?: { id: string; group: string; status: string; attempt: number };
  stuck?: string;
}

// the fields a lead needs, without the noise
const brief = (c: Card) => ({
  id: c.id,
  column: c.column,
  reason: c.stuck ? `stuck: ${c.stuck}` : c.reason,
  title: c.title,
  ticket: c.ticket,
  path: c.path,
  branch: c.branch,
  session: c.session && `${c.session.id} (${c.session.status})`,
  pr: c.pr && `#${c.pr.number} ${c.pr.state.toLowerCase()}${c.pr.checks ? `, checks ${c.pr.checks}` : ""}${c.pr.review ? `, ${c.pr.review.toLowerCase()}` : ""} ${c.pr.url}`,
  verify: c.verify?.state,
  autopilot: c.autopilot?.on ? (c.autopilot.gaveUp ? "gave up" : `on, ${c.autopilot.attempts} tries`) : undefined,
  task: c.task && `${c.task.group}/${c.task.id} ${c.task.status}${c.task.attempt > 1 ? ` attempt ${c.task.attempt}` : ""}`,
});

const server = new McpServer({ name: "cockpit", version: "0.1.0" });

server.registerTool(
  "list_workers",
  {
    description:
      "Every piece of work in flight on the cockpit Board: worktrees, Claude sessions outside them and queued tasks, each with its column (queued, working, needs, review, ready), why it's there, its session, PR and checks. Start here.",
    inputSchema: { column: z.enum(["queued", "working", "needs", "review", "ready", "quiet"]).optional().describe("Only this column") },
  },
  wrap(async ({ column }: { column?: string }) => ((await call("GET", "/board")) as Card[]).filter((c) => !column || c.column === column).map(brief)),
);

server.registerTool(
  "read_screen",
  {
    description: "What a running Claude session shows right now: the end of its screen, a question or permission menu it's waiting on (with option keys), any unsent draft, and its last message.",
    inputSchema: { session_id: z.string() },
  },
  wrap(({ session_id }: { session_id: string }) => call("GET", `/sessions/${encodeURIComponent(session_id)}/ask`)),
);

server.registerTool(
  "send_message",
  {
    description: "Type a message into a running Claude session and press Enter, as if the user typed it. Only works for sessions running in cockpit's terminals; check read_screen first so you don't talk over a menu.",
    inputSchema: { session_id: z.string(), text: z.string().min(1) },
  },
  wrap(async ({ session_id, text }: { session_id: string; text: string }) => {
    const r = await call("POST", `/sessions/${encodeURIComponent(session_id)}/send`, { text });
    return r.sent ? "Sent." : "Couldn't reach that session's terminal. It isn't running inside cockpit; ask the user to answer it.";
  }),
);

server.registerTool(
  "answer_prompt",
  {
    description: "Answer a menu a session is showing (see read_screen): option numbers like \"1\", or Escape, Enter, Up, Down, Tab. Never approve anything destructive without the user.",
    inputSchema: { session_id: z.string(), keys: z.array(z.string()).min(1) },
  },
  wrap(async ({ session_id, keys }: { session_id: string; keys: string[] }) => ((await call("POST", `/sessions/${encodeURIComponent(session_id)}/keys`, { keys })).sent ? "Sent." : "Nothing sent: unreachable session or keys that aren't allowed.")),
);

server.registerTool(
  "start_task",
  {
    description:
      "Queue work for a new worker: cockpit makes a worktree and branch, then starts a coding agent there with the prompt (Claude Code unless agent says otherwise; see list_agents). attempts > 1 runs that many independent tries to compare; lineup instead runs one try per entry, each with its own agent and model, to compare agents. after = task or group ids it must wait for (a wave). Returns the tasks created.",
    inputSchema: {
      title: z.string().min(1),
      prompt: z.string().optional().describe("What the worker should do and how to check it's done; empty uses the ticket"),
      ticket: z.string().optional(),
      attempts: z.number().int().min(1).max(4).optional(),
      agent: z.string().optional().describe("claude, codex, gemini... (list_agents); empty is the default"),
      model: z.string().optional().describe("one of the agent's models from list_agents, e.g. opus or sonnet for claude; empty is its default"),
      lineup: z
        .array(z.object({ agent: z.string().optional(), model: z.string().optional() }))
        .min(1)
        .max(4)
        .optional()
        .describe("one attempt per entry, e.g. [{agent:'claude',model:'opus'},{agent:'codex'}]"),
      after: z.array(z.string()).optional(),
    },
  },
  wrap((a: { title: string; prompt?: string; ticket?: string; attempts?: number; agent?: string; model?: string; lineup?: { agent?: string; model?: string }[]; after?: string[] }) =>
    call("POST", "/tasks", { ...a, dependsOn: a.after }),
  ),
);

server.registerTool(
  "list_agents",
  { description: "The coding agents cockpit can start workers with: whether each is installed, its models (the first is the default) and what it's good at.", inputSchema: {} },
  wrap(async () => ((await call("GET", "/agents")) as { id: string; name: string; installed: boolean; about?: string; models: { id: string }[] }[]).map((a) => ({ id: a.id, name: a.name, installed: a.installed, about: a.about, models: a.models.map((m) => m.id) }))),
);

server.registerTool(
  "list_flows",
  { description: "The flows cockpit can run: recipes of steps that pass one piece of work between coding agents in one worktree (plan, build, check, review, loop back on changes). With runs: true, the runs too, with each step's status.", inputSchema: { runs: z.boolean().optional() } },
  wrap(async ({ runs }: { runs?: boolean }) => ({
    flows: ((await call("GET", "/flows")) as { id: string; name: string; description?: string; steps: { id: string; kind?: string; agent?: string }[] }[]).map((f) => ({ id: f.id, name: f.name, description: f.description, steps: f.steps.map((s) => `${s.id}${s.kind && s.kind !== "agent" ? ` (${s.kind})` : s.agent ? ` (${s.agent})` : ""}`) })),
    ...(runs ? { runs: ((await call("GET", "/flows/runs")) as { id: string; title: string; status: string; steps: { step: string; round: number; status: string }[] }[]).slice(0, 20).map((r) => ({ id: r.id, title: r.title, status: r.status, steps: r.steps.map((s) => `${s.step}#${s.round}: ${s.status}`) })) } : {}),
  })),
);

server.registerTool(
  "start_flow",
  {
    description: "Run a flow (see list_flows) on a piece of work: cockpit makes one worktree and runs the flow's steps there, each with its own agent. Returns the run; follow it with list_flows runs: true.",
    inputSchema: { flow: z.string(), title: z.string().min(1), prompt: z.string().optional().describe("What to do and how to check it's done; empty uses the ticket"), ticket: z.string().optional() },
  },
  wrap((a: { flow: string; title: string; prompt?: string; ticket?: string }) => call("POST", "/flows/runs", a)),
);

server.registerTool("list_tasks", { description: "Every task cockpit has queued or run, newest first, with status, worktree, session and group.", inputSchema: {} }, wrap(() => call("GET", "/tasks")));

server.registerTool(
  "task_group",
  { description: "One task's attempts side by side: status, files changed with line counts, cost and session of each.", inputSchema: { group: z.string() } },
  wrap(({ group }: { group: string }) => call("GET", `/tasks/group/${encodeURIComponent(group)}`)),
);

server.registerTool("cancel_task", { description: "Stop a queued or running task; its worktree stays.", inputSchema: { id: z.string() } }, wrap(({ id }: { id: string }) => call("POST", `/tasks/${encodeURIComponent(id)}/cancel`)));

server.registerTool(
  "pr_status",
  {
    description: "The user's pull requests with state, checks and review decision. With number and details=true, also what Claude would be told to fix: failing checks with log tails, or the unresolved review comments.",
    inputSchema: { number: z.number().int().optional(), details: z.enum(["checks", "comments"]).optional() },
  },
  wrap(async ({ number, details }: { number?: number; details?: "checks" | "comments" }) => {
    const prs = (await call("GET", "/prs")).mine as { number: number; title: string; url: string; state: string; checks?: string; reviewDecision?: string; branch: string }[];
    const list = prs.filter((p) => (number ? p.number === number : p.state === "OPEN")).map((p) => ({ number: p.number, title: p.title, url: p.url, branch: p.branch, state: p.state, checks: p.checks, review: p.reviewDecision }));
    if (number && details) return { pr: list[0], ...(await call("GET", `/prs/${number}/fix?kind=${details}`)) };
    return list;
  }),
);

server.registerTool(
  "verify",
  { description: "Run the repo's own checks (repo.verifyCommand) in a worktree now. The result shows on the worker in list_workers.", inputSchema: { worktree: z.string() } },
  wrap(({ worktree }: { worktree: string }) => call("POST", "/verify", { worktree })),
);

server.registerTool(
  "autopilot",
  { description: "Turn autopilot on or off for a worktree: failing checks and requested changes on its PR go back to its session by themselves, up to a few tries.", inputSchema: { worktree: z.string(), on: z.boolean() } },
  wrap(({ worktree, on }: { worktree: string; on: boolean }) => call("POST", "/autopilot", { worktree, on })),
);

server.registerTool(
  "report_run",
  {
    description:
      "Record a test, lint, typecheck, audit or e2e command you ran, with its exit code and the end of its output, so it shows on cockpit's Runs screen and on its ticket. Only needed when cockpit's Claude hook isn't installed (it records Bash runs by itself).",
    inputSchema: {
      command: z.string().min(1),
      cwd: z.string().describe("The folder it ran in"),
      exit_code: z.number().int(),
      kind: z.enum(["unit", "lint", "typecheck", "audit", "e2e", "proof", "other"]).optional().describe("Worked out from the command when left out"),
      name: z.string().optional(),
      ticket: z.string().optional(),
      output: z.string().optional().describe("The end of its output, a few hundred lines at most"),
    },
  },
  wrap(async (a: { command: string; cwd: string; exit_code: number; kind?: string; name?: string; ticket?: string; output?: string }) => {
    const r = await call("POST", "/runs", { finished: true, source: "mcp", command: a.command, cwd: a.cwd, exitCode: a.exit_code, kind: a.kind, name: a.name, ticket: a.ticket, output: a.output });
    return `Recorded as ${r.run.kind} run ${r.id} (${r.run.status}): ${BASE}${r.link}`;
  }),
);

await server.connect(new StdioServerTransport());
