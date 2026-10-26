import { useSettings } from "./cost";
import { useAgents } from "./queries";

// The main coding agent's name, for the words on screen: "Claude" unless Settings → Board and automation picked
// another one, like Codex
export function useAgentName() {
  const id = useSettings().data?.settings.tasks.defaultAgent;
  const other = !!id && id !== "claude";
  const agents = useAgents(other).data;
  return other ? (agents?.find((a) => a.id === id)?.name ?? id) : "Claude";
}

// whether Claude Code is the main agent, for what only it has (its plan limits, its hook, its resume picker)
export function useClaudeMain() {
  const id = useSettings().data?.settings.tasks.defaultAgent;
  return !id || id === "claude";
}
