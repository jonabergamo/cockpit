// Cockpit's tools for Claude Code, over MCP on stdio. A lead session uses them to see every worker, queue tasks,
// answer workers and follow their PRs. Every tool is a thin call to the cockpit server on this machine.
//   claude mcp add --scope user cockpit -- <tsx> <this file>
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.COCKPIT_URL ?? "http://127.0.0.1:8770").replace(/\/$/, "");

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  // the server's own words when it gave some, rather than its JSON
  if (!res.ok) {
    let said: unknown;
    try {
      said = (JSON.parse(text) as { error?: unknown }).error;
    } catch {}
    throw new Error(typeof said === "string" ? said : `${res.status}: ${text.slice(0, 400)}`);
  }
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
      "Queue work for a new worker: cockpit makes a worktree and branch, then starts the main coding agent (set in cockpit's Settings) there with the prompt. attempts > 1 runs that many independent tries to compare. after = task or group ids it must wait for (a wave). Returns the tasks created.",
    inputSchema: {
      title: z.string().min(1),
      prompt: z.string().optional().describe("What the worker should do and how to check it's done; empty uses the ticket"),
      ticket: z.string().optional(),
      attempts: z.number().int().min(1).max(4).optional(),
      model: z.string().optional().describe("e.g. opus, sonnet, haiku when the main agent is Claude; empty is the default"),
      after: z.array(z.string()).optional(),
    },
  },
  wrap((a: { title: string; prompt?: string; ticket?: string; attempts?: number; model?: string; after?: string[] }) => call("POST", "/tasks", { ...a, dependsOn: a.after })),
);

server.registerTool("list_tasks", { description: "Every task cockpit has queued or run, newest first, with status, worktree, session and group.", inputSchema: {} }, wrap(() => call("GET", "/tasks")));

server.registerTool(
  "task_group",
  { description: "One task's attempts side by side: status, files changed with line counts, cost and session of each.", inputSchema: { group: z.string() } },
  wrap(({ group }: { group: string }) => call("GET", `/tasks/group/${encodeURIComponent(group)}`)),
);

server.registerTool("cancel_task", { description: "Stop a queued or running task; its worktree stays.", inputSchema: { id: z.string() } }, wrap(({ id }: { id: string }) => call("POST", `/tasks/${encodeURIComponent(id)}/cancel`)));

server.registerTool(
  "review_lessons",
  {
    description:
      "The points reviewers keep raising on recent PRs, distilled from the review comments cockpit kept, most raised first, with counts and an example each. Check a diff against them before opening a PR, or look for them when reviewing one.",
    inputSchema: {},
  },
  wrap(async () => {
    const r = (await call("GET", "/reviews/lessons")) as { lessons: { rule: string; count: number; prs: number; examples: string[]; dismissed: boolean }[]; at?: number; note?: string };
    return { lessons: r.lessons.filter((l) => !l.dismissed).map(({ rule, count, prs, examples }) => ({ rule, count, prs, examples })), updated: r.at ? new Date(r.at).toISOString() : null, note: r.note };
  }),
);

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

// The canvas: terminals as cards, with lines between them that can pass each finished turn of one agent to the other
const WHO = "The worker: a task id, a session id, a worktree path, a terminal id or a card id from canvas_view";
type Found = { canvas: string; workspace: string; node: { id: string; kind: string; x: number; y: number; w: number; h: number } };
const find = (who: string) => call("GET", `/canvas/find?who=${encodeURIComponent(who)}`) as Promise<Found>;

server.registerTool(
  "canvas_view",
  {
    description:
      "The Terminals canvas: each workspace's cards (terminals with their session and folder, notes with their text, tickets) and the lines between them, with each line's role (review, plan, build, custom), which way it goes, its gate, hops used of its limit and how the last thing it carried went, with the last message on each line (lastMessage: who to whom, hop, outcome, its start).",
    inputSchema: { workspace: z.string().optional().describe("Only this workspace, by name or id") },
  },
  wrap(({ workspace }: { workspace?: string }) => call("GET", `/canvas/view${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`)),
);

server.registerTool(
  "open_beside",
  {
    description:
      "Open Codex or the local model (Settings → Automation → Quick answers) beside a worker's terminal, in its folder and linked to it. as: chat (a line you can hand answers over), reviewer (each turn the worker finishes goes to it and the review comes back, 4 hops), review (a one-off read-only review of the folder's changes).",
    inputSchema: { who: z.string().describe(WHO), agent: z.enum(["codex", "local"]), as: z.enum(["chat", "reviewer", "review"]).optional().describe("chat when left out") },
  },
  wrap(({ who, agent, as }: { who: string; agent: string; as?: string }) => call("POST", "/canvas/beside", { who, agent, as })),
);

server.registerTool(
  "link",
  {
    description:
      "Draw a line between two cards on the same workspace, and with a role make it pass each finished turn of `from` on to `to`. A review line goes both ways (the review comes back) and hands the reviewer the turn's git diff unless with_diff is false. when: passing only passes turns after which its checks pass, failing only ones where something fails. limit: hops before it stops until someone types into either end (keep it low, 2-4). panel: give two or more review lines from the same worker the same panel name and they review together: each reviewer gets the turn, and their reviews come back merged into one.",
    inputSchema: {
      from: z.string().describe(WHO),
      to: z.string().describe(WHO),
      role: z.enum(["review", "plan", "build", "custom"]).optional().describe("Left out: a plain line that passes nothing on"),
      prompt: z.string().optional().describe("What the other end should do with it; needed for custom"),
      both: z.boolean().optional().describe("Turns go both ways; on by default for review"),
      when: z.enum(["every", "passing", "failing"]).optional(),
      limit: z.number().int().min(1).max(20).optional().describe("3 when left out"),
      with_diff: z.boolean().optional(),
      panel: z.string().regex(/^[\w-]{1,40}$/).optional().describe("Review lines from the same worker with the same panel review together (review role only)"),
      spec: z.boolean().optional().describe("Between a note and a terminal: the note becomes the spec of every relay line at that terminal, its text sent with each turn (no role)"),
    },
  },
  wrap(async (a: { from: string; to: string; role?: "review" | "plan" | "build" | "custom"; prompt?: string; both?: boolean; when?: string; limit?: number; with_diff?: boolean; panel?: string; spec?: boolean }) => {
    const [from, to] = await Promise.all([find(a.from), find(a.to)]);
    if (from.canvas !== to.canvas) throw new Error(`They're on different workspaces (${from.workspace} and ${to.workspace}); a line can only join cards on one`);
    if (a.spec && a.role) throw new Error("A spec line joins a note to a terminal and passes nothing on: leave out role");
    const line = (await call("POST", `/canvas/${from.canvas}/edges`, { source: from.node.id, target: to.node.id })) as { id: string; source: string };
    if (a.spec) {
      await call("PATCH", `/canvas/edges/${line.id}/spec`, { spec: true });
      return { line: line.id, spec: true };
    }
    if (!a.role) return { line: line.id, relay: "none" };
    // a line already drawn the other way round keeps its ends, so the turns go from `from` all the same
    const both = a.both ?? a.role === "review";
    const relay = { from: both ? "both" : line.source === from.node.id ? "source" : "target", role: a.role, prompt: a.prompt, when: a.when === "every" ? undefined : a.when, limit: a.limit ?? 3, withDiff: a.with_diff, panel: a.panel };
    await call("PATCH", `/canvas/edges/${line.id}`, { relay });
    return { line: line.id, ...relay };
  }),
);

server.registerTool(
  "unlink",
  {
    description: "Remove a line (its id from canvas_view), or with keep=true only stop it passing turns on and leave a plain line.",
    inputSchema: { line: z.string(), keep: z.boolean().optional() },
  },
  wrap(async ({ line, keep }: { line: string; keep?: boolean }) => {
    await call(keep ? "PATCH" : "DELETE", `/canvas/edges/${encodeURIComponent(line)}`, keep ? { relay: null } : undefined);
    return keep ? "It's a plain line now." : "Removed.";
  }),
);

server.registerTool(
  "hand_off",
  {
    description: "Hand the last answer of the agent at one end of a line to the agent at the other, once, with what to do with it. It waits while the other end is busy.",
    inputSchema: { line: z.string(), from: z.string().describe(`source or target (the line's from and to in canvas_view), or ${WHO.toLowerCase()}`), ask: z.string().optional() },
  },
  wrap(async ({ line, from, ask }: { line: string; from: string; ask?: string }) => {
    let end = from === "source" || from === "target" ? from : undefined;
    if (!end) {
      const card = (await find(from)).node.id;
      const edge = ((await call("GET", "/canvas")) as { edges: { id: string; source: string; target: string }[] }[]).flatMap((c) => c.edges).find((e) => e.id === line);
      if (!edge) throw new Error("No such line");
      end = edge.source === card ? "source" : edge.target === card ? "target" : undefined;
      if (!end) throw new Error(`${from} isn't at either end of that line`);
    }
    await call("POST", `/canvas/edges/${encodeURIComponent(line)}/handoff`, { from: end, ask });
    return "Handed over.";
  }),
);

server.registerTool(
  "add_note",
  {
    description:
      "Put a markdown note on the canvas: beside a card and linked to it when near is given, else on the workspace named (or the first one). spec: near is a worker's terminal and the note becomes the spec of its relay lines, its text sent along with each turn (a reviewer judges the change against it). send_spec also sends it to that terminal now, to start from.",
    inputSchema: {
      text: z.string().min(1),
      near: z.string().optional().describe(WHO),
      workspace: z.string().optional().describe("By name or id, when near isn't given"),
      spec: z.boolean().optional().describe("Make the note the spec of the terminal it's put beside (needs near)"),
      send_spec: z.boolean().optional().describe("With spec: send the spec to the terminal now, once"),
    },
  },
  wrap(async ({ text, near, workspace, spec, send_spec }: { text: string; near?: string; workspace?: string; spec?: boolean; send_spec?: boolean }) => {
    if (spec && !near) throw new Error("A spec note goes beside the terminal it's the spec of: give near");
    if (near) {
      const f = await find(near);
      if (spec && f.node.kind !== "term") throw new Error(`That's a ${f.node.kind} card: a note can only be the spec of a terminal`);
      const note = (await call("POST", `/canvas/${f.canvas}/notes`, { text, x: f.node.x + f.node.w + 40, y: f.node.y })) as { id: string };
      const line = (await call("POST", `/canvas/${f.canvas}/edges`, { source: f.node.id, target: note.id })) as { id: string };
      if (!spec) return { note: note.id, workspace: f.workspace, linkedTo: f.node.id };
      await call("PATCH", `/canvas/edges/${line.id}/spec`, { spec: true });
      const sent = send_spec ? ((await call("POST", `/canvas/nodes/${note.id}/spec/send`, {})) as { sent: string[] }).sent : undefined;
      return { note: note.id, workspace: f.workspace, linkedTo: f.node.id, specFor: f.node.id, ...(sent ? { sentTo: sent } : {}) };
    }
    const all = (await call("GET", "/canvas")) as { id: string; name: string }[];
    const ws = workspace ? all.find((c) => c.id === workspace || c.name.toLowerCase() === workspace.trim().toLowerCase()) : all[0];
    if (!ws) throw new Error(`No workspace called ${workspace}. There are: ${all.map((c) => c.name).join(", ")}`);
    const note = (await call("POST", `/canvas/${ws.id}/notes`, { text })) as { id: string };
    return { note: note.id, workspace: ws.name };
  }),
);

server.registerTool(
  "arrange",
  {
    description: "Tidy a canvas workspace: a block for each ticket (its card, its workers beside it, reviewers below), one for each repo's other terminals, the notes and cards linked to them alongside, three blocks to a row.",
    inputSchema: { workspace: z.string().optional().describe("By name or id; the first one when left out") },
  },
  wrap(async ({ workspace }: { workspace?: string }) => {
    const all = (await call("GET", "/canvas")) as { id: string; name: string }[];
    const ws = workspace ? all.find((c) => c.id === workspace || c.name.toLowerCase() === workspace.trim().toLowerCase()) : all[0];
    if (!ws) throw new Error(`No workspace called ${workspace}. There are: ${all.map((c) => c.name).join(", ")}`);
    const { nodes } = (await call("POST", `/canvas/${ws.id}/arrange`, {})) as { nodes: unknown[] };
    return { workspace: ws.name, arranged: nodes.length };
  }),
);

await server.connect(new StdioServerTransport());
