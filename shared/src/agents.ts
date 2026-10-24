// Coding agents besides Claude Code's own terminal: CLIs like Codex or Gemini that can be picked as cockpit's main
// agent. Cockpit runs them a turn at a time without a terminal, reading what they print as JSON lines. A task on
// Claude still gets its usual terminal.

// how much an agent may do on its own: write in its folder and run commands there (sandbox), anything (full), or
// only read (readonly, for reviews and plans)
export type AgentAccess = "sandbox" | "full" | "readonly";

export interface AgentModel {
  id: string;
  label: string;
}

// One turn of work: a first prompt, or a follow-up to the conversation the agent gave an id for
export interface AgentTurn {
  prompt: string;
  cwd: string;
  model?: string;
  access: AgentAccess;
  // the agent's own id for the conversation, from its first turn
  resume?: string;
  // folders outside cwd it may also write to, like a worktree's git folder so it can commit
  writable?: string[];
}

// What an agent prints, in cockpit's words. Lines it doesn't know give nothing.
export type AgentEvent =
  | { kind: "session"; id: string; model?: string }
  | { kind: "message"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; text: string; isError: boolean }
  | { kind: "usage"; input: number; output: number; cached?: number; costUSD?: number }
  | { kind: "done"; ok: boolean; text?: string }
  | { kind: "error"; text: string };

export interface AgentProvider {
  id: string;
  name: string;
  // the command, unless config.local.toml's [agents.<id>] bin says otherwise
  bin: string;
  // what it's good at, for the lead session and the pickers
  about?: string;
  // the models to offer, read on the machine that runs it; the first is the default
  models?(): AgentModel[] | Promise<AgentModel[]>;
  // the arguments for one turn; the prompt goes in on stdin
  headless(turn: AgentTurn): string[];
  // one line of its output; state is kept per turn, for agents that spread one thing over several lines
  parse(line: string, state: Record<string, unknown>): AgentEvent[];
  // the arguments to open the conversation in its own interactive UI, in a terminal
  terminal?(resume?: string, model?: string): string[];
  // the arguments that log it in, run in a terminal
  login?: string[];
  // whether the conversation is in the middle of a turn right now, as the agent's own files say, for when it's
  // open in its own screen rather than run a turn at a time by cockpit; undefined when it can't tell
  busy?(resume: string): boolean | undefined;
}

// an agent as the screens and the lead see it
export interface AgentInfo {
  id: string;
  name: string;
  about?: string;
  installed: boolean;
  // false when it's turned off in Settings
  enabled: boolean;
  version?: string;
  models: AgentModel[];
  terminal: boolean;
}
