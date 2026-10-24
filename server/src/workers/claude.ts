// Claude Code without its terminal: claude -p, printing stream-json. Tasks on Claude still get the usual terminal;
// this is for work nobody watches as it happens, like the steps of a flow.
import type { AgentAccess, AgentEvent, AgentProvider } from "@cockpit/shared";

const ACCESS: Record<AgentAccess, string[]> = {
  sandbox: ["--permission-mode", "acceptEdits"],
  readonly: ["--permission-mode", "plan"],
  full: ["--dangerously-skip-permissions"],
};

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
    ...ACCESS[t.access],
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
