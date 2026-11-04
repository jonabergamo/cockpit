// The Terminals page as a canvas: workspaces of terminal and note cards you can drag, resize and zoom.
// The layout lives on the server, so every device shows the same one; terminals stay live while you pan.
import { Background, Controls, MiniMap, NodeResizer, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow, useStoreApi, type Node, type NodeChange, type NodeProps, type Viewport } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CanvasInfo, CanvasNode, TermInfo } from "@cockpit/shared";
import { api } from "../lib/api";
import { saveView, saveWorkspace, savedWorkspace, tabId, useCanvases } from "../lib/canvas";
import { shortPath } from "../lib/format";
import { launcher } from "../lib/launcher";
import { useLiveSessions } from "../lib/live";
import { termPrefs, useCopyOnSelect } from "../lib/termPrefs";
import { useTerms } from "../pages/Terminals";
import { Terminal } from "./Terminal";
import { Button, ErrorNote, inputClass, Markdown } from "./ui";

const TERM_W = 720;
const TERM_H = 440;
const NOTE_W = 320;
const NOTE_H = 260;

type TermData = { term: TermInfo; title: string };
type NoteData = { fresh: boolean };
type TermCardNode = Node<TermData, "term">;
type NoteCardNode = Node<NoteData, "note">;
type CardNode = TermCardNode | NoteCardNode;

interface Actions {
  others: CanvasInfo[];
  bringUp: (node: string) => void;
  move: (term: string, to: string) => void;
  close: (term: string) => void;
  openTab: (term: string) => void;
  removeNote: (node: string) => void;
  fail: (e: unknown) => void;
}
const ActionsCtx = createContext<Actions | null>(null);
const useActions = () => useContext(ActionsCtx)!;

// xterm turns a mouse position into a cell from the distance to its screen's corner, in unscaled pixels. Under the
// canvas zoom that distance is scaled too, so selection would land on the wrong cell; this scales it back. A drag
// carries on over the whole document, so once a press starts inside the terminal its moves and release are too.
const fixed = new WeakSet<Event>();
function useZoomFix(box: React.RefObject<HTMLDivElement | null>) {
  // read at the moment of the event, so panning and zooming don't redraw every terminal card
  const store = useStoreApi();
  useEffect(() => {
    let screen: HTMLElement | null = null;
    const redo = (e: MouseEvent) => {
      const zoom = store.getState().transform[2];
      if (fixed.has(e) || !screen || Math.abs(zoom - 1) < 0.001) return;
      const r = screen.getBoundingClientRect();
      const copy = new MouseEvent(e.type, {
        bubbles: e.bubbles,
        cancelable: e.cancelable,
        composed: true,
        clientX: r.left + (e.clientX - r.left) / zoom,
        clientY: r.top + (e.clientY - r.top) / zoom,
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
  }, [box, store]);
}

const iconBtn = "size-6 grid place-items-center rounded text-faint hover:text-ink hover:bg-ground";

function TermCard({ id, data, selected }: NodeProps<TermCardNode>) {
  const a = useActions();
  const box = useRef<HTMLDivElement>(null);
  useZoomFix(box);
  const t = data.term;
  const dot = t.exited !== undefined ? "bg-line" : t.state === "disconnected" ? "bg-amber animate-pulse" : "bg-green";
  return (
    <div className={`h-full w-full flex flex-col rounded-lg border bg-panel shadow-lg overflow-hidden ${selected ? "border-cobalt" : "border-line"}`} data-card={t.id}>
      <NodeResizer isVisible={selected} minWidth={360} minHeight={220} color="var(--cobalt)" />
      <div className="card-handle cursor-grab active:cursor-grabbing flex items-center gap-2 h-8 pl-2.5 pr-1 bg-raised border-b border-line text-[12px] shrink-0" onDoubleClick={() => a.bringUp(id)} title="Drag to move, double-click to see it at 100%">
        <span className={`size-2 rounded-full shrink-0 ${dot}`} />
        {t.node && t.node !== "local" && <span className="text-[11px] px-1 rounded bg-ground text-muted shrink-0">{t.node}</span>}
        <span className="truncate font-medium">{data.title}</span>
        <span className="truncate text-faint" title={t.cwd}>
          {shortPath(t.cwd)}
        </span>
        <div className="ml-auto flex items-center gap-0.5 nodrag shrink-0">
          {a.others.length > 0 && (
            <select value="" onChange={(e) => e.target.value && a.move(t.id, e.target.value)} className="h-6 rounded bg-transparent text-faint hover:text-ink text-[12px] px-1 cursor-pointer" title="Move it to another workspace" aria-label="Move to workspace">
              <option value="">Move</option>
              {a.others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={() => a.openTab(t.id)} className={iconBtn} title="Open it in its own tab" aria-label="Open in a tab">
            ↗
          </button>
          <button type="button" onClick={() => a.close(t.id)} className={`${iconBtn} hover:!text-red`} title="Close this terminal" aria-label="Close terminal">
            ×
          </button>
        </div>
      </div>
      <div ref={box} className="relative flex-1 min-h-0 nodrag nowheel nopan">
        <Terminal id={t.id} autoFocus={false} />
      </div>
    </div>
  );
}

function NoteCard({ id, data, selected }: NodeProps<NoteCardNode>) {
  const a = useActions();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["note", id], queryFn: () => api.get<{ text: string }>(`/canvas/nodes/${id}/note`), staleTime: Infinity });
  const [editing, setEditing] = useState(data.fresh);
  const [draft, setDraft] = useState<string>();
  const pending = useRef<string | undefined>(undefined);
  const timer = useRef(0);
  const value = draft ?? q.data?.text ?? "";
  const send = () => {
    const text = pending.current;
    if (text === undefined) return;
    pending.current = undefined;
    api.put(`/canvas/nodes/${id}/note`, { text }).then(() => qc.setQueryData(["note", id], { text }), a.fail);
  };
  const type = (v: string) => {
    setDraft(v);
    pending.current = v;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(send, 400);
  };
  // a note scrolled off screen is unmounted; what was typed last still gets saved
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      send();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const heading = value.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") || "Note";
  return (
    <div className={`h-full w-full flex flex-col rounded-lg border bg-raised shadow-md overflow-hidden ${selected ? "border-cobalt" : "border-line"}`} data-note={id}>
      <NodeResizer isVisible={selected} minWidth={200} minHeight={140} color="var(--cobalt)" />
      <div className="card-handle cursor-grab active:cursor-grabbing flex items-center gap-2 h-8 pl-2.5 pr-1 border-b border-line text-[12px] shrink-0">
        <span className="truncate font-medium text-muted">{heading}</span>
        <div className="ml-auto flex items-center gap-0.5 nodrag shrink-0">
          <button type="button" onClick={() => setEditing(!editing)} className="h-6 px-1.5 rounded text-faint hover:text-ink hover:bg-ground">
            {editing ? "Done" : "Edit"}
          </button>
          <button type="button" onClick={() => a.removeNote(id)} className={`${iconBtn} hover:!text-red`} title="Delete this note" aria-label="Delete note">
            ×
          </button>
        </div>
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={value}
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
          placeholder="Markdown: what this workspace is for, what's next, links..."
          className="nodrag nowheel nopan flex-1 min-h-0 w-full resize-none bg-transparent p-3 font-mono text-[13px] text-ink placeholder:text-faint outline-none"
          aria-label="Note text"
        />
      ) : (
        <div className="nowheel flex-1 min-h-0 overflow-auto p-3 text-[13px]" onDoubleClick={() => setEditing(true)}>
          {value.trim() ? <Markdown>{value}</Markdown> : <span className="text-faint">Empty. Double-click to write.</span>}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { term: TermCard, note: NoteCard };

const VIEWPORT = (ws: string) => `cockpit.canvasViewport.${ws}`;
const readViewport = (ws: string): Viewport | undefined => {
  try {
    return JSON.parse(localStorage.getItem(VIEWPORT(ws)) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
};
const writeViewport = (ws: string, v: Viewport) => {
  try {
    localStorage.setItem(VIEWPORT(ws), JSON.stringify(v));
  } catch {}
};

function Board({ focus, switcher }: { focus?: string; switcher: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const flow = useReactFlow<CardNode>();
  const canvases = useCanvases();
  const terms = useTerms();
  const live = useLiveSessions();
  const copyOnSelect = useCopyOnSelect();
  const wrap = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState(savedWorkspace);
  const list = canvases.data ?? [];
  const ws = list.find((c) => c.id === picked) ?? list[0];
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const [err, setErr] = useState<unknown>();
  const [fresh, setFresh] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [nodes, setNodes, applyChanges] = useNodesState<CardNode>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // cards being dragged or resized keep their own place until it's saved, whatever else redraws meanwhile
  const moving = useRef(new Set<string>());

  const pick = (id: string) => {
    setPicked(id);
    saveWorkspace(id);
  };
  const byId = useMemo(() => new Map((terms.data ?? []).map((t) => [t.id, t])), [terms.data]);
  const titleOf = (t: TermInfo) => {
    const s = live.find((x) => x.id === t.session || x.term === t.id || (!!t.pid && x.pid === t.pid && (t.node ?? "local") === (x.node ?? "local")));
    return s?.title || s?.name || t.title;
  };

  // what the server has, with the cards in hand left where they are
  useEffect(() => {
    if (!ws) return;
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      const out: CardNode[] = [];
      for (const n of ws.nodes) {
        const was = old.get(n.id);
        const keep = moving.current.has(n.id) ? was : undefined;
        const base = { id: n.id, position: keep?.position ?? { x: n.x, y: n.y }, width: keep?.width ?? n.w, height: keep?.height ?? n.h, dragHandle: ".card-handle", selected: was?.selected };
        if (n.kind === "note") {
          out.push({ ...base, type: "note", data: { fresh: n.id === fresh } });
          continue;
        }
        // its terminal has closed, or its machine hasn't listed it yet
        const t = byId.get(n.ref);
        if (t) out.push({ ...base, type: "term", data: { term: t, title: titleOf(t) } });
      }
      return out;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, byId, live, fresh, setNodes]);

  // each workspace opens where you left it, or fitted the first time
  const shownWs = useRef<string>(undefined);
  useEffect(() => {
    if (!ws || shownWs.current === ws.id || (focus && ws.nodes.some((n) => n.ref === focus))) return;
    shownWs.current = ws.id;
    const saved = readViewport(ws.id);
    setTimeout(() => (saved ? flow.setViewport(saved) : flow.fitView({ maxZoom: 1, padding: 0.1 })), 30);
  }, [ws, focus, flow]);

  // a link to one terminal (a session card, a notification) opens its workspace and brings it to 100%
  const focused = useRef<string>(undefined);
  useEffect(() => {
    if (!focus || focused.current === focus || !list.length) return;
    const home = list.find((c) => c.nodes.some((n) => n.kind === "term" && n.ref === focus));
    if (!home) return;
    if (home.id !== ws?.id) return pick(home.id);
    const n = nodes.find((x) => x.type === "term" && x.data.term.id === focus);
    if (!n) return;
    focused.current = focus;
    shownWs.current = home.id;
    setTimeout(() => flow.setCenter(n.position.x + (n.width ?? TERM_W) / 2, n.position.y + (n.height ?? TERM_H) / 2, { zoom: 1, duration: 250 }), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, list, ws, nodes, flow]);

  // once a drag or resize ends, the new place goes to the server and to the cached copy at once
  const commit = (ids: string[]) =>
    setTimeout(() => {
      const cur = wsRef.current;
      if (!cur) return;
      const boxes = nodesRef.current.filter((n) => ids.includes(n.id)).map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.width ?? n.measured?.width ?? TERM_W, h: n.height ?? n.measured?.height ?? TERM_H }));
      const at = new Map(boxes.map((b) => [b.id, b]));
      qc.setQueryData<CanvasInfo[]>(["canvas"], (old) => old?.map((c) => (c.id !== cur.id ? c : { ...c, nodes: c.nodes.map((n) => ({ ...n, ...at.get(n.id) })) })));
      ids.forEach((i) => moving.current.delete(i));
      api.put(`/canvas/${cur.id}/layout`, { nodes: boxes, by: tabId }).catch((e) => {
        setErr(e);
        qc.invalidateQueries({ queryKey: ["canvas"] });
      });
    }, 50);

  const onNodesChange = (changes: NodeChange<CardNode>[]) => {
    // cards only leave through their own buttons
    applyChanges(changes.filter((c) => c.type !== "remove"));
    const ended: string[] = [];
    for (const c of changes) {
      if (c.type !== "position" && c.type !== "dimensions") continue;
      const busy = c.type === "position" ? c.dragging : c.resizing;
      if (busy) moving.current.add(c.id);
      else if (busy === false) ended.push(c.id);
    }
    if (ended.length) commit(ended);
  };

  const refresh = () => qc.invalidateQueries({ queryKey: ["canvas"] });
  const guard = (p: Promise<unknown>) => p.catch(setErr);
  // the middle of what's on screen, for a new card to show up in
  const centre = (w: number, h: number) => {
    const r = wrap.current?.getBoundingClientRect();
    const p = r ? flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
    return { x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2) };
  };

  // a new card goes in the middle of the screen, or beside what's there already; either way it's brought into view
  const show = (n: CanvasNode) => flow.setCenter(n.x + n.w / 2, n.y + n.h / 2, { zoom: flow.getZoom(), duration: 250 });
  const newTerminal = () => {
    const target = ws?.id;
    if (!target) return;
    const at = centre(TERM_W, TERM_H);
    launcher.open("claude", (term) =>
      guard(
        api.post<CanvasNode>(`/canvas/${target}/terms`, { term, ...at, by: tabId }).then(async (n) => {
          await refresh();
          show(n);
        }),
      ),
    );
  };
  const newNote = () =>
    ws &&
    guard(
      api.post<CanvasNode>(`/canvas/${ws.id}/notes`, { ...centre(NOTE_W, NOTE_H), by: tabId }).then(async (n) => {
        setFresh(n.id);
        await refresh();
        show(n);
      }),
    );
  const newWorkspace = () =>
    guard(
      api.post<CanvasInfo>("/canvas", { name: `Workspace ${list.length + 1}`, by: tabId }).then(async (c) => {
        await refresh();
        pick(c.id);
        setRenaming(c.id);
      }),
    );
  const rename = (id: string, name: string) => {
    setRenaming(undefined);
    const was = list.find((c) => c.id === id)?.name;
    if (!name.trim() || name.trim() === was) return;
    guard(api.patch(`/canvas/${id}`, { name, by: tabId }).then(refresh));
  };
  const removeWorkspace = (c: CanvasInfo) => {
    const notes = c.nodes.filter((n) => n.kind === "note").length;
    const terminals = c.nodes.filter((n) => n.kind === "term").length;
    const what = [terminals && `its ${terminals === 1 ? "terminal moves" : `${terminals} terminals move`} to ${list.find((x) => x.id !== c.id)?.name}`, notes && `its ${notes === 1 ? "note is" : `${notes} notes are`} deleted`].filter(Boolean).join(" and ");
    if (!confirm(`Delete the workspace "${c.name}"?${what ? ` ${what[0].toUpperCase()}${what.slice(1)}.` : ""}`)) return;
    guard(api.del(`/canvas/${c.id}`).then(refresh));
  };

  const actions: Actions = {
    others: list.filter((c) => c.id !== ws?.id),
    bringUp: (id) => {
      const n = flow.getNode(id);
      if (n) flow.setCenter(n.position.x + (n.width ?? TERM_W) / 2, n.position.y + (n.height ?? TERM_H) / 2, { zoom: 1, duration: 250 });
    },
    move: (term, to) => guard(api.post(`/canvas/${to}/terms`, { term, by: tabId }).then(refresh)),
    close: (term) => guard(api.del(`/code/terms/${term}`).then(() => qc.invalidateQueries({ queryKey: ["terms"] }))),
    openTab: (term) => {
      saveView("tabs");
      navigate({ to: "/terminals", search: { id: term, view: "tabs" } });
    },
    removeNote: (node) => {
      if (!confirm("Delete this note?")) return;
      qc.setQueryData<CanvasInfo[]>(["canvas"], (old) => old?.map((c) => ({ ...c, nodes: c.nodes.filter((n) => n.id !== node) })));
      guard(api.del(`/canvas/nodes/${node}?by=${tabId}`));
    },
    fail: setErr,
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center h-11 border-b border-line bg-panel shrink-0">
        <div className="flex items-center gap-1 px-2 h-full border-r border-line shrink-0">{switcher}</div>
        <div className="flex items-center gap-0.5 px-2 h-full min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="Workspaces">
          {list.map((c) =>
            renaming === c.id ? (
              <input
                key={c.id}
                autoFocus
                defaultValue={c.name}
                onFocus={(e) => e.target.select()}
                onBlur={(e) => rename(c.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") rename(c.id, e.currentTarget.value);
                  if (e.key === "Escape") setRenaming(undefined);
                }}
                className={`${inputClass} !h-7 w-40 text-[13px]`}
                aria-label="Workspace name"
              />
            ) : (
              <div key={c.id} className={`group flex items-center h-7 rounded-md shrink-0 ${c.id === ws?.id ? "bg-ground text-ink" : "text-muted hover:text-ink"}`}>
                <button type="button" role="tab" aria-selected={c.id === ws?.id} onClick={() => pick(c.id)} onDoubleClick={() => setRenaming(c.id)} className="px-2.5 h-full text-[13px]" title="Double-click to rename">
                  {c.name}
                  <span className="ml-1.5 text-faint tabular-nums">{c.nodes.filter((n) => n.kind === "term" && byId.has(n.ref)).length || ""}</span>
                </button>
                {c.id === ws?.id && list.length > 1 && (
                  <button type="button" onClick={() => removeWorkspace(c)} className="size-6 mr-0.5 rounded text-faint hover:text-red hidden group-hover:grid place-items-center" aria-label={`Delete workspace ${c.name}`}>
                    ×
                  </button>
                )}
              </div>
            ),
          )}
          <button type="button" onClick={newWorkspace} className="size-7 grid place-items-center rounded-md text-muted hover:text-ink hover:bg-ground shrink-0" title="New workspace" aria-label="New workspace">
            +
          </button>
        </div>
        <div className="flex items-center gap-1 px-2 h-full border-l border-line shrink-0">
          <Button size="sm" variant="ghost" onClick={newTerminal} title="A new terminal on this workspace">
            + Terminal
          </Button>
          <Button size="sm" variant="ghost" onClick={newNote} title="A markdown note on this workspace">
            + Note
          </Button>
          <Button size="sm" variant="ghost" onClick={() => flow.fitView({ maxZoom: 1, padding: 0.1, duration: 250 })} title="Fit every card on screen">
            Fit
          </Button>
          <Button size="sm" variant={copyOnSelect ? "default" : "ghost"} onClick={() => termPrefs.setCopyOnSelect(!copyOnSelect)} title="Copy text as soon as you select it" className="hidden lg:inline-flex">
            Copy on select
          </Button>
        </div>
      </div>
      <ErrorNote error={err ?? canvases.error} />
      <div ref={wrap} className="relative flex-1 min-h-0" data-testid="canvas">
        <ActionsCtx.Provider value={actions}>
          <ReactFlow
            nodes={nodes}
            onNodesChange={onNodesChange}
            nodeTypes={nodeTypes}
            minZoom={0.2}
            maxZoom={2}
            onlyRenderVisibleElements
            deleteKeyCode={null}
            zoomOnDoubleClick={false}
            panOnScroll
            onMoveEnd={(_, v) => ws && writeViewport(ws.id, v)}
            proOptions={{ hideAttribution: true }}
            className="cockpit-canvas"
          >
            <Background gap={24} color="var(--line)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable bgColor="var(--panel)" maskColor="color-mix(in srgb, var(--ground) 70%, transparent)" nodeColor={(n) => (n.type === "note" ? "var(--faint)" : "var(--line)")} className="hidden md:block" />
          </ReactFlow>
        </ActionsCtx.Provider>
        {ws && !nodes.length && !canvases.isLoading && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="text-center text-muted text-[13px] pointer-events-auto">
              <p>Nothing on {ws.name} yet.</p>
              <div className="mt-3 flex gap-2 justify-center">
                <Button size="sm" onClick={newTerminal}>
                  + Terminal
                </Button>
                <Button size="sm" variant="ghost" onClick={newNote}>
                  + Note
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function TermCanvas({ focus, switcher }: { focus?: string; switcher: ReactNode }) {
  return (
    <ReactFlowProvider>
      <Board focus={focus} switcher={switcher} />
    </ReactFlowProvider>
  );
}
