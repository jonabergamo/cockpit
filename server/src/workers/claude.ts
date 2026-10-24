// Claude Code without its terminal: claude -p, printing stream-json. Tasks on Claude get the usual terminal; this is
// for a conversation started through the agents API, which runs a turn at a time like any other agent.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentAccess, AgentEvent, AgentProvider } from "@cockpit/shared";

// what a turn nobody can approve anything in still needs: reading the repo's state, and committing its work
const GIT = ["Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git add:*)", "Bash(git commit:*)"];

// Claude Code's own sandbox (bubblewrap and socat on Linux, built in on macOS): commands run fenced into the folder
// and need no approval, which is what Codex's workspace-write does
const onPath = (bin: string) => (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
const canSandbox = () => process.platform === "darwin" || (onPath("bwrap") && onPath("socat"));

function access(a: AgentAccess) {
  if (a === "full") return ["--dangerously-skip-permissions"];
  if (a === "readonly") return ["--permission-mode", "plan"];
  return [
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    ...GIT,
    ...(canSandbox() ? ["--settings", JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } })] : []),
  ];
}

const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("") : "");

export const claude: AgentProvider = {
  id: "claude",
  name: "Claude Code",
  bin: "claude",
  about: "Careful planning, large changes across a codebase and following a repo's own skills and CLAUDE.md.",
  models: () => [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  headless: (t) => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(t.model ? ["--model", t.model] : []),
    ...(t.resume ? ["--resume", t.resume] : []),
    ...access(t.access),
    ...(t.writable ?? []).flatMap((d) => ["--add-dir", d]),
  ],
  parse(line) {
    const d = JSON.parse(line);
    const out: AgentEvent[] = [];
    if (d.type === "system" && d.subtype === "init") out.push({ kind: "session", id: d.session_id, model: d.model });
    if (d.type === "assistant") {
      for (const c of d.message?.content ?? []) {
        if (c.type === "text" && c.text?.trim()) out.push({ kind: "message", text: c.text });
        if (c.type === "thinking" && c.thinking?.trim()) out.push({ kind: "thinking", text: c.thinking });
        if (c.type === "tool_use") out.push({ kind: "tool", id: c.id, name: c.name, input: c.input });
      }
    }
    if (d.type === "user") {
      for (const c of d.message?.content ?? []) if (c.type === "tool_result") out.push({ kind: "tool_result", id: c.tool_use_id, text: text(c.content), isError: !!c.is_error });
    }
    if (d.type === "result") {
      const u = d.usage ?? {};
      out.push({ kind: "usage", input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, cached: u.cache_read_input_tokens, costUSD: d.total_cost_usd });
      out.push({ kind: "done", ok: !d.is_error && d.subtype === "success", text: d.result });
    }
    return out;
  },
  terminal: (resume, model) => [...(model ? ["--model", model] : []), ...(resume ? ["--resume", resume] : [])],
  login: [],
};
