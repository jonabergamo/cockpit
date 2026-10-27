import type { ReactNode } from "react";
import { useAgentName, useClaudeMain } from "../lib/agent";

// Says a feature is Claude Code's own, when the main agent is another one; nothing while it's Claude Code
export function ClaudeOnly({ what, children, className = "" }: { what: string; children?: ReactNode; className?: string }) {
  const claudeMain = useClaudeMain();
  const agent = useAgentName();
  if (claudeMain) return null;
  return (
    <div className={`bg-panel border border-amber/50 rounded-lg px-4 py-3 text-[13px] ${className}`}>
      <span className="font-medium">Not available for {agent}.</span>{" "}
      <span className="text-muted">
        {what} is a Claude Code feature, so it only works with Claude Code. {children}
      </span>
    </div>
  );
}
