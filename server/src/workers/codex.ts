// OpenAI's Codex CLI: codex exec --json, one turn per run, and exec resume <thread> for the next one
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentProvider, AgentTurn } from "@cockpit/shared";

const toml = (v: unknown) => JSON.stringify(v);

function access(t: AgentTurn) {
  if (t.access === "full") return ["--dangerously-bypass-approvals-and-sandbox"];
  if (t.access === "readonly") return ["-c", `sandbox_mode=${toml("read-only")}`, "-c", `approval_policy=${toml("never")}`];
  // a worktree keeps its git data in the main checkout, outside the folder Codex may write to, so it couldn't commit
  return ["-c", `sandbox_mode=${toml("workspace-write")}`, "-c", `approval_policy=${toml("never")}`, ...(t.writable?.length ? ["-c", `sandbox_workspace_write.writable_roots=${toml(t.writable)}`] : [])];
}

// the models Codex lists in its picker, from what it last fetched
function models() {
  try {
    const cache = JSON.parse(readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json"), "utf8"));
    const listed = (cache.models ?? []).filter((m: { visibility?: string }) => m.visibility !== "hide");
    if (listed.length) return listed.map((m: { slug: string; display_name?: string }) => ({ id: m.slug, label: m.display_name ?? m.slug }));
  } catch {}
  return [];
}

export const codex: AgentProvider = {
  id: "codex",
  name: "Codex",
  bin: "codex",
  about: "Focused implementation and bug fixes with tests; quick and economical on well-scoped tasks.",
  models,
  headless: (t) => [
    "exec",
    ...(t.resume ? ["resume"] : []),
    "--json",
    "--skip-git-repo-check",
    ...(t.model ? ["-m", t.model] : []),
    ...access(t),
    ...(t.resume ? [t.resume] : []),
    "-",
  ],
  parse(line, state) {
    const d = JSON.parse(line);
    const out: AgentEvent[] = [];
    const started = (state.started ??= new Set<string>()) as Set<string>;
    const item = d.item ?? {};
    const tool = (name: string, input: unknown): AgentEvent => ({ kind: "tool", id: item.id, name, input });
    if (d.type === "thread.started") out.push({ kind: "session", id: d.thread_id });
    if (d.type === "item.started" && item.type === "command_execution") {
      started.add(item.id);
      out.push(tool("Bash", { command: item.command }));
    }
    if (d.type === "item.completed") {
      if (item.type === "agent_message" && item.text?.trim()) {
        state.last = item.text;
        out.push({ kind: "message", text: item.text });
      }
      if (item.type === "reasoning" && item.text?.trim()) out.push({ kind: "thinking", text: item.text });
      if (item.type === "command_execution") {
        if (!started.has(item.id)) out.push(tool("Bash", { command: item.command }));
        out.push({ kind: "tool_result", id: item.id, text: item.aggregated_output ?? "", isError: item.exit_code !== 0 });
      }
      if (item.type === "file_change") {
        out.push(tool("Edit", { changes: item.changes }));
        out.push({ kind: "tool_result", id: item.id, text: (item.changes ?? []).map((c: { kind?: string; path?: string }) => `${c.kind ?? "update"} ${c.path}`).join("\n"), isError: item.status === "failed" });
      }
      if (item.type === "mcp_tool_call") {
        out.push(tool(`${item.server}.${item.tool}`, item.arguments));
        out.push({ kind: "tool_result", id: item.id, text: JSON.stringify(item.result ?? item.error ?? ""), isError: item.status === "failed" });
      }
      if (item.type === "web_search") out.push(tool("WebSearch", { query: item.query }));
      if (item.type === "error") out.push({ kind: "error", text: item.message });
    }
    if (d.type === "turn.completed") {
      const u = d.usage ?? {};
      out.push({ kind: "usage", input: u.input_tokens ?? 0, output: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0), cached: u.cached_input_tokens });
      out.push({ kind: "done", ok: true, text: state.last as string | undefined });
    }
    if (d.type === "turn.failed") out.push({ kind: "error", text: d.error?.message ?? "the turn failed" }, { kind: "done", ok: false });
    if (d.type === "error") out.push({ kind: "error", text: d.message ?? "error" });
    return out;
  },
  terminal: (resume, model) => [...(resume ? ["resume", resume] : []), ...(model ? ["-m", model] : [])],
  login: ["login"],
};
