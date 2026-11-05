import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, useInternalNode, type Edge, type EdgeProps, type InternalNode } from "@xyflow/react";
import { useActions, type LinkData } from "./context";

// The dots on a card's sides to draw a line from; any dot links to any other card
export function Ports() {
  return (
    <>
      <Handle type="source" position={Position.Left} id="l" className="canvas-port" />
      <Handle type="source" position={Position.Right} id="r" className="canvas-port" />
    </>
  );
}

const what = { work: "works on", talk: "linked to", note: "note on", watch: "shows its changes" } as const;

const box = (n: InternalNode) => {
  const { x, y } = n.internals.positionAbsolute;
  return { x, y, w: n.measured.width ?? n.width ?? 0, h: n.measured.height ?? n.height ?? 0 };
};

// Where a line leaves each card: the sides facing each other, left and right, or top and bottom when one card sits
// above the other. So a line never loops round behind the cards, wherever they're dragged.
function ends(a: InternalNode, b: InternalNode) {
  const s = box(a);
  const t = box(b);
  const dx = t.x + t.w / 2 - (s.x + s.w / 2);
  const dy = t.y + t.h / 2 - (s.y + s.h / 2);
  const stacked = Math.abs(dx) < (s.w + t.w) / 2 && Math.abs(dy) > Math.abs(dx);
  if (stacked) {
    const down = dy > 0;
    return {
      sourceX: s.x + s.w / 2,
      sourceY: down ? s.y + s.h : s.y,
      sourcePosition: down ? Position.Bottom : Position.Top,
      targetX: t.x + t.w / 2,
      targetY: down ? t.y : t.y + t.h,
      targetPosition: down ? Position.Top : Position.Bottom,
    };
  }
  const right = dx > 0;
  return {
    sourceX: right ? s.x + s.w : s.x,
    sourceY: s.y + s.h / 2,
    sourcePosition: right ? Position.Right : Position.Left,
    targetX: right ? t.x : t.x + t.w,
    targetY: t.y + t.h / 2,
    targetPosition: right ? Position.Left : Position.Right,
  };
}

// A line between two cards. Selecting one you drew shows its × to take it away; cockpit's own (a terminal in its
// ticket's worktree) stay while that's true.
export function LinkEdge({ id, source, target, selected, data }: EdgeProps<Edge<LinkData>>) {
  const a = useActions();
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const [path, x, y] = getBezierPath(ends(s, t));
  const kind = data?.kind ?? "talk";
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={18} className={`canvas-link canvas-link-${kind} ${data?.live ? "canvas-link-live" : ""} ${selected ? "canvas-link-selected" : ""}`} />
      {selected && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan absolute flex items-center gap-1 rounded-full border border-line bg-raised shadow px-2 h-6 text-[11px] text-muted" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, pointerEvents: "all" }}>
            <span>{data?.auto ? "runs in its worktree" : what[kind]}</span>
            {!data?.auto && (
              <button type="button" onClick={() => a.removeEdge(id)} className="size-4 grid place-items-center rounded-full hover:bg-red-soft hover:text-red" aria-label="Remove this link">
                ×
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
