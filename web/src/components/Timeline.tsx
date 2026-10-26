import { Link } from "@tanstack/react-router";
import { memo, useState } from "react";
import type { Entry, Subagent } from "@cockpit/shared";
import { time } from "../lib/format";
import { Markdown } from "./ui";

type Tool = Extract<Entry, { kind: "tool" }>;
type Result = Extract<Entry, { kind: "tool_result" }>;

function summary(t: Tool) {
  const i = (t.input ?? {}) as Record<string, any>;
  const v = i.description ?? i.command ?? i.file_path ?? i.pattern ?? i.query ?? i.url ?? i.skill ?? i.prompt ?? i.action ?? "";
  return String(v).split("\n")[0].slice(0, 160);
}

const ToolRow = memo(function ToolRow({ tool, result, agent, sessionId }: { tool: Tool; result?: Result; agent?: Subagent; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const err = result?.isError;
  const pending = !result;
  const input = tool.input as Record<string, any>;

  return (
    <div className={`rounded-md border ${err ? "border-red/40" : "border-line"} bg-raised`}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-2.5 h-8 text-left">
        <span className={`size-1.5 rounded-full shrink-0 ${pending ? "bg-cobalt animate-pulse" : err ? "bg-red" : "bg-green"}`} />
        <span className="font-medium text-[13px] shrink-0">{tool.name}</span>
        <span className="truncate text-muted text-[13px]">{summary(tool)}</span>
        {agent && (
          <Link
            to="/sessions/$id"
            params={{ id: sessionId }}
            search={{ agent: agent.id }}
            onClick={(e) => e.stopPropagation()}
            className="ml-auto shrink-0 text-[12px] text-cobalt hover:underline"
          >
            Open agent
          </Link>
        )}
        <span className={`${agent ? "" : "ml-auto"} text-[11px] text-faint shrink-0`}>{time(tool.ts)}</span>
      </button>
      {open && (
        <div className="border-t border-line px-2.5 py-2 space-y-2">
          {tool.name === "Edit" && input?.old_string !== undefined ? (
            <div className="font-mono text-[12px] whitespace-pre-wrap break-words">
              <div className="text-muted mb-1">{input.file_path}</div>
              <div className="bg-red-soft text-red rounded px-2 py-1 mb-1">{input.old_string}</div>
              <div className="bg-green-soft text-green rounded px-2 py-1">{input.new_string}</div>
            </div>
          ) : (
            <pre className="font-mono text-[12px] whitespace-pre-wrap break-words max-h-80 overflow-auto text-muted">{JSON.stringify(tool.input, null, 2)}</pre>
          )}
          {result && <pre className={`font-mono text-[12px] whitespace-pre-wrap break-words max-h-96 overflow-auto ${err ? "text-red" : ""}`}>{result.text || "(empty)"}</pre>}
        </div>
      )}
    </div>
  );
});

export function Timeline({ entries, agents = [], sessionId }: { entries: Entry[]; agents?: Subagent[]; sessionId: string }) {
  const results = new Map<string, Result>();
  for (const e of entries) if (e.kind === "tool_result") results.set(e.toolUseId, e);
  const byTool = new Map(agents.filter((a) => a.toolUseId).map((a) => [a.toolUseId!, a]));

  return (
    <div className="space-y-2.5">
      {entries.map((e, i) => {
        const node = entryNode(e);
        // the index lets the scrubber find an entry on screen
        return (
          node && (
            <div key={e.id} data-i={i}>
              {node}
            </div>
          )
        );
      })}
    </div>
  );

  function entryNode(e: Entry) {
    switch (e.kind) {
      case "user":
        return (
          <div key={e.id} className="border-l-[3px] border-cobalt bg-cobalt-soft/50 rounded-r-md px-3 py-2">
            <div className="text-[11px] text-muted mb-0.5">You · {time(e.ts)}</div>
            <div className="whitespace-pre-wrap break-words">{e.text}</div>
          </div>
        );
      case "assistant":
        return (
          <div key={e.id} className="px-1">
            <Markdown>{e.text}</Markdown>
          </div>
        );
      case "thinking":
        return (
          <details key={e.id} className="px-1 text-muted">
            <summary className="cursor-pointer text-[13px]">Thinking</summary>
            <div className="whitespace-pre-wrap text-[13px] mt-1">{e.text}</div>
          </details>
        );
      case "tool":
        return <ToolRow key={e.id} tool={e} result={results.get(e.toolUseId)} agent={byTool.get(e.toolUseId)} sessionId={sessionId} />;
      case "system":
        if (e.subtype === "turn") return <div key={e.id} className="text-[12px] text-faint text-center">turn took {e.text}</div>;
        if (e.subtype === "away") return <div key={e.id} className="text-[13px] text-muted border border-dashed border-line rounded-md px-3 py-2">{e.text}</div>;
        // what an agent run a turn at a time stopped on, like a login that ran out
        if (e.subtype === "error") return <div key={e.id} className="text-[13px] text-red bg-red-soft border border-red/40 rounded-md px-3 py-2 whitespace-pre-wrap">{e.text}</div>;
        return null;
      default:
        return null;
    }
  }
}
