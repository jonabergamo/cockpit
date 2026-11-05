import { type Node, type NodeProps } from "@xyflow/react";
import { useNavigate } from "@tanstack/react-router";
import { useRun } from "../../lib/queries";
import { LiveView } from "../LiveView";
import { Ports } from "./LinkEdge";

// A recording run's screen (the simulator, or the virtual screen an e2e records on), beside the runs card it's on.
// It's on the canvas only while that run is recording: it shows up when the run starts and goes when it ends, and
// isn't saved anywhere.
export type ScreenData = { runId: string; name: string; src: string; recording: boolean };
export type ScreenCardNode = Node<ScreenData, "screen">;

export const SCREEN_W = 300;
export const SCREEN_H = 580;

export function ScreenCard({ data, selected }: NodeProps<ScreenCardNode>) {
  const navigate = useNavigate();
  // its steps, asked again every few seconds while it runs
  const run = useRun(data.runId).data;
  const steps = (run?.steps ?? []).filter((s) => s.state !== "section");
  const now = steps.findLast((s) => s.state === "running") ?? steps.at(-1);
  const done = steps.filter((s) => s.state === "ok").length;
  const failed = steps.filter((s) => s.state === "failed").length;
  return (
    <div className={`h-full w-full flex flex-col rounded-lg border-2 bg-panel shadow-lg overflow-hidden text-[12px] ${selected ? "border-cobalt" : "border-red/70"}`} data-screen={data.runId}>
      <Ports />
      <div className="card-handle flex items-center gap-2 h-8 pl-2.5 pr-1 bg-raised border-b border-line shrink-0">
        <span className="size-2 rounded-full bg-red animate-pulse shrink-0" />
        <span className="font-medium shrink-0">{data.recording ? "Recording" : "Live"}</span>
        <span className="truncate text-faint" title={data.name}>
          {data.name}
        </span>
        <button type="button" onClick={() => navigate({ to: "/runs/$id", params: { id: data.runId } })} className="nodrag ml-auto size-6 grid place-items-center rounded text-faint hover:text-ink hover:bg-ground shrink-0" title="Open the run" aria-label="Open the run">
          ↗
        </button>
      </div>
      <LiveView src={data.src} className="flex-1 min-h-0 grid place-items-center" tall="max-h-full" />
      <div className="shrink-0 border-t border-line px-2.5 py-1.5 flex items-center gap-2 text-muted min-h-8">
        {now ? (
          <>
            <span className={`shrink-0 size-1.5 rounded-full ${now.state === "failed" ? "bg-red" : now.state === "ok" ? "bg-green" : "bg-cobalt animate-pulse"}`} />
            <span className="truncate flex-1" title={now.text}>
              {now.text}
            </span>
          </>
        ) : (
          <span className="flex-1 text-faint">Starting</span>
        )}
        {(done > 0 || failed > 0) && (
          <span className="shrink-0 tabular-nums">
            <span className="text-green">{done}✓</span>
            {failed > 0 && <span className="text-red"> {failed}✗</span>}
          </span>
        )}
      </div>
    </div>
  );
}
