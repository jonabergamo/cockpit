// P0 spike: cockpit's terminals as nodes on a pan/zoom canvas. Not linked from the nav yet; open /canvas.
// It tries the three ways a terminal can live under the canvas zoom, so they can be compared side by side.
import { Background, Controls, MiniMap, NodeResizer, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow, useViewport, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "../components/Terminal";
import { Button } from "../components/ui";
import { api } from "../lib/api";
import { useTerms } from "./Terminals";

// scale: the canvas zoom applies to the terminal as is
// fix: same, but mouse positions are corrected for the zoom before xterm sees them
// focus: a terminal only takes input at 100%; at any other zoom a click brings it to 100% first
export type ZoomMode = "scale" | "fix" | "focus";

type TermNode = Node<{ id: string; title: string; mode: ZoomMode }, "term">;

const LAYOUT = "canvas-spike-layout";
const W = 640;
const H = 400;

const load = (): Record<string, { x: number; y: number; w: number; h: number }> => {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT) ?? "{}");
  } catch {
    return {};
  }
};

// xterm turns a mouse position into a cell from the distance to its screen's corner, in unscaled pixels. Under a
// zoom that distance is scaled too, so selection lands on the wrong cell; this rescales it back. Drags carry on
// over the whole document, so once a press starts inside a terminal its moves and release are corrected as well.
const fixed = new WeakSet<Event>();
function useZoomFix(box: React.RefObject<HTMLDivElement | null>, on: boolean, zoom: React.RefObject<number>) {
  useEffect(() => {
    if (!on) return;
    let screen: HTMLElement | null = null;
    const redo = (e: MouseEvent) => {
      if (fixed.has(e) || !screen || Math.abs(zoom.current - 1) < 0.001) return;
      const r = screen.getBoundingClientRect();
      const copy = new MouseEvent(e.type, {
        bubbles: e.bubbles,
        cancelable: e.cancelable,
        composed: true,
        clientX: r.left + (e.clientX - r.left) / zoom.current,
        clientY: r.top + (e.clientY - r.top) / zoom.current,
        screenX: e.screenX,
        screenY: e.screenY,
        button: e.button,
        buttons: e.buttons,
        detail: e.detail,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        view: window,
      });
      fixed.add(copy);
      e.stopImmediatePropagation();
      e.preventDefault();
      e.target?.dispatchEvent(copy);
    };
    const down = (e: MouseEvent) => {
      const s = (e.target as HTMLElement).closest?.(".xterm-screen") as HTMLElement | null;
      if (!s || !box.current?.contains(s)) return;
      screen = s;
      redo(e);
    };
    const move = (e: MouseEvent) => screen && redo(e);
    const up = (e: MouseEvent) => {
      if (!screen) return;
      redo(e);
      screen = null;
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
    };
  }, [on, box, zoom]);
}

function TermCard({ id: nodeId, data, selected }: NodeProps<TermNode>) {
  const { zoom } = useViewport();
  const flow = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useZoomFix(box, data.mode === "fix", zoomRef);
  const live = data.mode !== "focus" || Math.abs(zoom - 1) < 0.01;
  const bringUp = () => {
    const n = flow.getNode(nodeId);
    if (!n) return;
    const w = n.measured?.width ?? W;
    const h = n.measured?.height ?? H;
    flow.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: 1, duration: 250 });
  };
  return (
    <div className="h-full w-full flex flex-col rounded-lg border border-line bg-panel shadow-lg overflow-hidden" data-card={data.id}>
      <NodeResizer isVisible={selected} minWidth={320} minHeight={200} />
      <div className="drag-handle cursor-grab active:cursor-grabbing flex items-center gap-2 px-2.5 py-1.5 bg-raised border-b border-line text-[12px]" onDoubleClick={bringUp}>
        <span className="size-2 rounded-full bg-accent" />
        <span className="truncate font-medium">{data.title}</span>
        <span className="ml-auto text-muted tabular-nums">{Math.round(zoom * 100)}%</span>
      </div>
      <div ref={box} className="relative flex-1 min-h-0 nodrag nowheel nopan">
        <Terminal id={data.id} />
        {!live && (
          <button type="button" className="absolute inset-0 z-20 cursor-zoom-in bg-transparent" onClick={bringUp} title="Bring to 100% to type" aria-label={`Bring ${data.title} to 100%`} />
        )}
      </div>
    </div>
  );
}

const nodeTypes = { term: TermCard };

// frames drawn per second while you pan, so the cost of several live terminals shows up as a number
function useFps() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0;
    let raf = 0;
    const tick = () => {
      frames++;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const timer = setInterval(() => {
      setFps(frames);
      frames = 0;
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
  }, []);
  return fps;
}

function Board() {
  const terms = useTerms();
  const [mode, setMode] = useState<ZoomMode>(() => (new URLSearchParams(location.search).get("mode") as ZoomMode) || "fix");
  const [cull, setCull] = useState(true);
  const fps = useFps();
  const tabs = useMemo(() => (terms.data ?? []).filter((t) => !t.parent && t.exited === undefined), [terms.data]);
  const [nodes, setNodes, onNodesChange] = useNodesState<TermNode>([]);
  // the spike's measuring script drives the viewport through this
  const flow = useReactFlow();
  useEffect(() => {
    (window as unknown as { __canvas?: typeof flow }).__canvas = flow;
  }, [flow]);

  // new terminals join in a grid; the ones already placed keep where you left them
  useEffect(() => {
    const saved = load();
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return tabs.map((t, i) => {
        const old = byId.get(t.id);
        const s = saved[t.id];
        return {
          id: t.id,
          type: "term" as const,
          dragHandle: ".drag-handle",
          position: old?.position ?? (s ? { x: s.x, y: s.y } : { x: (i % 3) * (W + 40), y: Math.floor(i / 3) * (H + 40) }),
          style: old?.style ?? { width: s?.w ?? W, height: s?.h ?? H },
          data: { id: t.id, title: t.title, mode },
        };
      });
    });
  }, [tabs, mode, setNodes]);

  // where every card sits, kept between visits (the real thing keeps this on the server)
  useEffect(() => {
    if (!nodes.length) return;
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const n of nodes) out[n.id] = { x: n.position.x, y: n.position.y, w: Number(n.style?.width ?? n.measured?.width ?? W), h: Number(n.style?.height ?? n.measured?.height ?? H) };
    try {
      localStorage.setItem(LAYOUT, JSON.stringify(out));
    } catch {}
  }, [nodes]);

  const newShell = () => api.post("/code/terms", { cwd: tabs[0]?.cwd ?? "/tmp", title: `shell ${tabs.length + 1}` });

  return (
    <div className="relative h-full w-full" data-testid="canvas">
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        minZoom={0.2}
        maxZoom={2}
        onlyRenderVisibleElements={cull}
        proOptions={{ hideAttribution: true }}
        fitView
        colorMode="system"
      >
        <Background gap={24} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
      <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 bg-raised border border-line rounded-md shadow px-2 py-1 text-[12px]">
        <span className="text-muted">Zoom mode</span>
        {(["scale", "fix", "focus"] as const).map((m) => (
          <Button key={m} size="sm" variant={mode === m ? "default" : "ghost"} onClick={() => setMode(m)}>
            {m}
          </Button>
        ))}
        <Button size="sm" variant={cull ? "default" : "ghost"} onClick={() => setCull(!cull)} title="Unmount terminals that are off screen">
          Cull off screen
        </Button>
        <Button size="sm" variant="ghost" onClick={newShell}>
          New shell
        </Button>
        <span className="ml-1 text-muted tabular-nums" data-testid="fps">
          {fps} fps · {tabs.length} terminals
        </span>
      </div>
    </div>
  );
}

export function CanvasPage() {
  return (
    <ReactFlowProvider>
      <Board />
    </ReactFlowProvider>
  );
}
