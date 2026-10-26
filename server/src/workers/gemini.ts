// Google's Gemini CLI: gemini with stream-json output. Its answer comes in pieces, put back together here.
import type { AgentAccess, AgentEvent, AgentProvider } from "@cockpit/shared";

// Gemini has no sandbox of its own without Docker: "sandbox" lets it edit files but not run commands
const ACCESS: Record<AgentAccess, string[]> = {
  sandbox: ["--approval-mode", "auto_edit"],
  readonly: ["--approval-mode", "plan"],
  full: ["--approval-mode", "yolo"],
};

export const gemini: AgentProvider = {
  id: "gemini",
  name: "Gemini",
  bin: "gemini",
  about: "A very large context: reading a lot of code at once, reviews and second opinions.",
  models: () => [
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  headless: (t) => [
    "--output-format",
    "stream-json",
    "--skip-trust",
    ...(t.model ? ["-m", t.model] : []),
    ...(t.resume ? ["--resume", t.resume] : []),
    ...ACCESS[t.access],
    ...(t.writable?.length ? ["--include-directories", t.writable.join(",")] : []),
    // what's on stdin is the prompt; -p only adds to it
    "-p",
    " ",
  ],
  parse(line, state) {
    const d = JSON.parse(line);
    const out: AgentEvent[] = [];
    const flush = () => {
      const text = (state.text as string | undefined)?.trim();
      if (text) out.push({ kind: "message", text }), (state.last = text);
      state.text = "";
    };
    if (d.type === "message" && d.role === "assistant") {
      state.text = `${state.text ?? ""}${d.content ?? ""}`;
      if (!d.delta) flush();
      return out;
    }
    flush();
    if (d.type === "init") out.push({ kind: "session", id: d.session_id, model: d.model });
    if (d.type === "tool_use") out.push({ kind: "tool", id: d.tool_id, name: d.tool_name, input: d.parameters });
    if (d.type === "tool_result") out.push({ kind: "tool_result", id: d.tool_id, text: typeof d.output === "string" ? d.output : JSON.stringify(d.output ?? d.error ?? ""), isError: d.status !== "success" });
    if (d.type === "error") out.push({ kind: "error", text: d.message ?? "error" });
    if (d.type === "result") {
      const s = d.stats ?? {};
      out.push({ kind: "usage", input: s.input_tokens ?? s.input ?? 0, output: s.output_tokens ?? 0, cached: s.cached });
      if (d.status !== "success") out.push({ kind: "error", text: d.error?.message ?? "the turn failed" });
      out.push({ kind: "done", ok: d.status === "success", text: state.last as string | undefined });
    }
    return out;
  },
  terminal: (resume, model) => [...(model ? ["-m", model] : []), ...(resume ? ["--resume", resume] : [])],
  start: (prompt) => ["-i", prompt],
  install: "npm install -g @google/gemini-cli",
  docs: "https://github.com/google-gemini/gemini-cli",
  login: [],
};
