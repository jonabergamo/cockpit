// The Terminals page as a canvas: workspaces of terminal, ticket and note cards you can drag, resize, zoom and link
// with lines. The layout lives on the server, so every device shows the same one; terminals stay live while you pan.
import {
  Background,
  ConnectionMode,
  MarkerType,
  Controls,
  MiniMap,
  NodeResizer,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CanvasInfo, CanvasNode, KitsRes, Run, SessionStatus, TermInfo, Worktree } from "@cockpit/shared";
import { useAgentName } from "../lib/agent";
import { api } from "../lib/api";
import { onFocusRequest, saveWorkspace, savedWorkspace, setCanvasSelected, tabId, useCanvases } from "../lib/canvas";
import { ago, shortPath } from "../lib/format";
import { launcher } from "../lib/launcher";
import { useLiveSessions } from "../lib/live";
import { liveSrc, recording } from "../lib/liveRun";
import { middleOf, openScreen, screenGroup, useScreens } from "../lib/screens";
import { folded, linkedTo, withFolded } from "./canvas/group";
import { useAppConfig, useRuns, useTickets, useWorktrees, type Job } from "../lib/queries";
import { termPrefs, useCopyOnSelect } from "../lib/termPrefs";
import { useTerms } from "../pages/Terminals";
import { AwayPanel } from "./canvas/AwayPanel";
import { AddMenu } from "./canvas/AddMenu";
import { Schedules, useSchedules } from "./canvas/Schedules";
import { CardFinder, type FoundCard } from "./canvas/CardFinder";
import { StatusFooter } from "./canvas/ContextMeter";
import { ChangesCard, type ChangesCardNode, type ChangesFrom } from "./canvas/ChangesCard";
import { ActionsCtx, useActions, type Actions, type CardTone, type LinkData, type LinkKind } from "./canvas/context";
import { useFit } from "./canvas/fit";
import { LinkEdge, Ports } from "./canvas/LinkEdge";
import { RunsCard, type RunsCardNode, type RunsFrom } from "./canvas/RunsCard";
import { PlanCard, type PlanCardNode, type PlanFrom } from "./canvas/PlanCard";
import { SCREEN_H, SCREEN_W, ScreenCard, type ScreenCardNode } from "./canvas/ScreenCard";
import { TicketCard, type TicketCardNode } from "./canvas/TicketCard";
import { SpawnMenu, type SpawnKind, type SpawnOption } from "./canvas/SpawnMenu";
import { TicketPicker } from "./canvas/TicketPicker";
import { WaitingStrip } from "./canvas/WaitingStrip";
import { VoiceStrip } from "./canvas/VoiceStrip";
import { useVoice, voice } from "../lib/voice";
import { useSettings } from "../lib/cost";
import { Terminal } from "./Terminal";
import { Button, ErrorNote, inputClass, Markdown } from "./ui";

const TERM_W = 720;
const TERM_H = 440;
const NOTE_W = 320;
const NOTE_H = 260;
const TICKET_W = 340;
const TICKET_H = 190;
const CHANGES_W = 440;
const CHANGES_H = 420;
const RUNS_W = 440;
const PLAN_W = 380;
const PLAN_H = 360;
const RUNS_H = 320;

// status: what its agent is doing, when an agent runs in it (busy, waiting on you, idle)
// archived: since when it's been put away, and what's folded into it
type TermData = { term: TermInfo; title: string; status?: SessionStatus; session?: string; cost?: number; archived?: number; folded?: string[] };
type NoteData = { fresh: boolean; fit?: boolean };
type TermCardNode = Node<TermData, "term">;
type NoteCardNode = Node<NoteData, "note">;
type CardNode = TermCardNode | NoteCardNode | TicketCardNode | ChangesCardNode | RunsCardNode | PlanCardNode | ScreenCardNode;
type LinkEdgeT = Edge<LinkData, "link">;

const within = (path: string, root: string) => path === root || path.startsWith(root + "/");

// xterm turns a mouse position into a cell from the distance to its screen's corner, in unscaled pixels. Under the
// canvas zoom that distance is scaled too, so selection would land on the wrong cell; this scales it back. A drag
// carries on over the whole document, so once a press starts inside the terminal its moves and release are too.
// Moving over a terminal without pressing is scaled as well: xterm finds the link under the mouse from those moves,
// and a click on a link only opens it when it lands on the link they found.
const fixed = new WeakSet<Event>();
function useZoomFix(box: React.RefObject<HTMLDivElement | null>) {
  // read at the moment of the event, so panning and zooming don't redraw every terminal card
  const store = useStoreApi();
  useEffect(() => {
    let screen: HTMLElement | null = null;
    const redo = (e: MouseEvent, over: HTMLElement | null = screen) => {
      const zoom = store.getState().transform[2];
      if (fixed.has(e) || !over || Math.abs(zoom - 1) < 0.001) return;
      const r = over.getBoundingClientRect();
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
    const move = (e: MouseEvent) => {
      if (screen) return redo(e);
      // hovering, for the links
      const s = (e.target as HTMLElement).closest?.(".xterm-screen") as HTMLElement | null;
      if (s && box.current?.contains(s)) redo(e, s);
    };
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
// the Move menu's choice of the other screen, next to the workspaces
const SCREEN = "__screen";

function TermCard(props: NodeProps<TermCardNode>) {
  return props.data.archived ? <ArchivedCard {...props} /> : <OpenTermCard {...props} />;
}

const STATUS: Record<string, string> = { waiting: "Waiting for you", busy: "Working", idle: "Idle" };

// A terminal put away: it keeps running, but shows as a small card saying what it is, how it's doing, the last thing
// its agent said and what's folded into it, until it's brought back
function ArchivedCard({ id, data, selected }: NodeProps<TermCardNode>) {
  const a = useActions();
  const t = data.term;
  const waiting = data.status === "waiting" && !!data.session;
  const last = useQuery({ queryKey: ["archived-last", data.session, data.status], queryFn: () => api.get<{ last?: string }>(`/sessions/${data.session}/ask`), enabled: !!data.session, staleTime: 60_000 }).data?.last;
  const exited = t.exited !== undefined;
  const dot = exited ? "bg-line" : t.state === "disconnected" ? "bg-amber animate-pulse" : data.status === "busy" ? "bg-cobalt animate-pulse" : data.status === "waiting" ? "bg-amber" : "bg-green";
  return (
    <div className={`h-full w-full flex flex-col rounded-lg border bg-panel shadow-lg overflow-hidden text-[12px] ${waiting ? "border-amber border-2 canvas-waiting" : selected ? "border-cobalt" : "border-line border-dashed"}`} data-card={t.id} data-archived={data.archived} data-status={data.status}>
      <Ports />
      <div className="card-handle cursor-grab active:cursor-grabbing flex items-center gap-2 h-8 pl-2.5 pr-1 bg-raised border-b border-line shrink-0" onDoubleClick={() => a.archive(id, false)} title="Drag to move, double-click to bring it back">
        <span className={`size-2 rounded-full shrink-0 ${dot}`} />
        {t.node && t.node !== "local" && <span className="text-[11px] px-1 rounded bg-ground text-muted shrink-0">{t.node}</span>}
        <span className="truncate font-medium">{data.title}</span>
        <div className="ml-auto flex items-center gap-0.5 nodrag shrink-0">
          <button type="button" onClick={() => a.archive(id, false)} className="h-6 px-1.5 rounded text-cobalt hover:bg-ground" title="Bring it back, with what's folded into it, where they were">
            Unarchive
          </button>
          <button type="button" onClick={() => a.close(t.id)} className={`${iconBtn} hover:!text-red`} title="Close this terminal" aria-label="Close terminal">
            ×
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 px-2.5 py-2 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-muted min-w-0">
          <span className={`shrink-0 ${waiting ? "text-amber font-medium" : ""}`}>{exited ? "Exited" : (STATUS[data.status ?? ""] ?? "Running")}</span>
          <span className="text-faint">·</span>
          <span className="truncate" title={t.cwd}>
            {shortPath(t.cwd)}
          </span>
        </div>
        {last && (
          <p className="text-ink/80 line-clamp-2 leading-snug" title={last} data-archived-last>
            {last}
          </p>
        )}
        {!!data.folded?.length && (
          <div className="flex flex-wrap gap-1" aria-label="Folded into it">
            {data.folded.map((f, i) => (
              <span key={i} className="px-1.5 rounded bg-ground text-muted text-[11px] max-w-[140px] truncate" title={f}>
                {f}
              </span>
            ))}
          </div>
        )}
        <div className="mt-auto text-faint text-[11px]">Archived {ago(data.archived)}</div>
      </div>
    </div>
  );
}

function OpenTermCard({ id, data, selected }: NodeProps<TermCardNode>) {
  const a = useActions();
  const box = useRef<HTMLDivElement>(null);
  useZoomFix(box);
  const t = data.term;
  const waiting = data.status === "waiting" && !!data.session;
  const v = useVoice();
  const talking = v.card === id && v.state === "listening";
  const voiceSend = !!useSettings().data?.settings.terminals?.voiceSend;
  const dot = t.exited !== undefined ? "bg-line" : t.state === "disconnected" ? "bg-amber animate-pulse" : data.status === "busy" ? "bg-cobalt animate-pulse" : "bg-green";
  return (
    <div className={`h-full w-full flex flex-col rounded-lg border bg-panel shadow-lg overflow-hidden ${waiting ? "border-amber border-2 canvas-waiting" : selected ? "border-cobalt" : "border-line"}`} data-card={t.id} data-status={data.status}>
      <NodeResizer isVisible={selected} minWidth={360} minHeight={220} color="var(--cobalt)" />
      <Ports />
      <div className="card-handle cursor-grab active:cursor-grabbing flex items-center gap-2 h-8 pl-2.5 pr-1 bg-raised border-b border-line text-[12px] shrink-0" onDoubleClick={() => a.bringUp(id)} title="Drag to move, double-click to bring it up">
        <span className={`size-2 rounded-full shrink-0 ${dot}`} />
        {t.node && t.node !== "local" && <span className="text-[11px] px-1 rounded bg-ground text-muted shrink-0">{t.node}</span>}
        <span className="truncate font-medium">{data.title}</span>
        {waiting && <span className="shrink-0 px-1.5 rounded-full bg-amber text-on-accent text-[11px] font-medium">Waiting for you</span>}
        <span className="truncate text-faint" title={t.cwd}>
          {shortPath(t.cwd)}
        </span>
        <div className="ml-auto flex items-center gap-0.5 nodrag shrink-0">
          <button type="button" onClick={(e) => a.spawn(id, e.currentTarget.getBoundingClientRect())} className={iconBtn} title="A new terminal beside this one, in its folder, linked to it" aria-label="New linked terminal">
            +
          </button>
          {(a.others.length > 0 || a.otherScreen) && (
            <select
              value=""
              onChange={(e) => (e.target.value === SCREEN ? a.toScreen(id) : e.target.value && a.move(t.id, e.target.value))}
              className="h-6 rounded bg-transparent text-faint hover:text-ink text-[12px] px-1 cursor-pointer"
              title="Move it to another workspace, or the other screen"
              aria-label="Move to workspace"
            >
              <option value="">Move</option>
              {a.otherScreen && <option value={SCREEN}>The other screen{a.otherScreen !== "here" ? ` (${a.otherScreen})` : ""}</option>}
              {a.others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => voice.toggle(id, t.id, voiceSend)}
            className={`${iconBtn} ${talking ? "!text-red" : ""}`}
            title={talking ? "Done: turn what you said into text and type it in" : "Say it instead of typing (v): it's typed in for you to read and send"}
            aria-label={talking ? "Stop talking" : "Talk to it"}
            aria-pressed={talking}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={talking ? "animate-pulse" : ""} aria-hidden>
              <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" fill={talking ? "currentColor" : "none"} />
              <path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2" />
            </svg>
          </button>
          <button type="button" onClick={() => a.archive(id, true)} className={iconBtn} title="Archive it: it keeps running, folded into a small card with what's linked to it" aria-label="Archive">
            ↧
          </button>
          <button type="button" onClick={() => a.openTab(t.id)} className={iconBtn} title="Open it in its own tab" aria-label="Open in a tab">
            ↗
          </button>
          <button type="button" onClick={() => a.close(t.id)} className={`${iconBtn} hover:!text-red`} title="Close this terminal" aria-label="Close terminal">
            ×
          </button>
        </div>
      </div>
      <VoiceStrip card={id} />
      {waiting && <WaitingStrip session={data.session!} selected={!!selected} onBringUp={() => a.bringUp(id)} onAnswered={() => a.nextWaiting(id)} onFail={a.fail} />}
      <div ref={box} className="relative flex-1 min-h-0 nodrag nowheel nopan">
        <Terminal id={t.id} autoFocus={false} onPin={(text) => a.pin(id, `From ${data.title}:`, text)} />
      </div>
      <StatusFooter session={data.session} busy={data.status === "busy"} cost={data.cost} />
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
  const fit = useFit({ id, selected, fit: data.fit, max: 560, minWidth: 200, minHeight: 100 });
  return (
    <div className={`w-full flex flex-col rounded-lg border bg-raised shadow-md overflow-hidden ${selected ? "border-cobalt" : "border-line"}`} style={fit.style} data-note={id}>
      {fit.resizer}
      <Ports />
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
          rows={data.fit ? Math.max(5, value.split("\n").length + 1) : undefined}
          className="nodrag nowheel nopan flex-auto min-h-0 w-full resize-none bg-transparent p-3 font-mono text-[13px] text-ink placeholder:text-faint outline-none"
          aria-label="Note text"
        />
      ) : (
        <div className="nowheel flex-auto min-h-0 overflow-auto p-3 text-[13px]" onDoubleClick={() => setEditing(true)}>
          {value.trim() ? <Markdown>{value}</Markdown> : <span className="text-faint">Empty. Double-click to write.</span>}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { term: TermCard, note: NoteCard, ticket: TicketCard, changes: ChangesCard, runs: RunsCard, plan: PlanCard, screen: ScreenCard };
const edgeTypes = { link: LinkEdge };

// what a line between these two kinds of card stands for
const watches = (k?: string) => k === "changes" || k === "runs" || k === "plan";
const kindOf = (a?: string, b?: string): LinkKind => (watches(a) || watches(b) ? "watch" : a === "note" || b === "note" ? "note" : a === "ticket" || b === "ticket" ? "work" : "talk");

// the minimap's colours: waiting on you, working, failing and passing stand out from across the canvas
const TONE_COLOUR: Record<CardTone, string> = { fail: "var(--red)", warn: "var(--amber)", running: "var(--cobalt)", pass: "var(--green)" };
const MAP = "cockpit.canvasMap";
const readMap = () => {
  try {
    return localStorage.getItem(MAP) !== "0";
  } catch {
    return true;
  }
};

// away this long and coming back shows what happened meanwhile
const AWAY_MS = 15 * 60_000;
const SEEN = (ws: string) => `cockpit.canvasSeen.${ws}`;
const readSeen = (ws: string) => {
  try {
    return Number(localStorage.getItem(SEEN(ws))) || undefined;
  } catch {
    return undefined;
  }
};
const writeSeen = (ws: string, at: number) => {
  try {
    localStorage.setItem(SEEN(ws), String(at));
  } catch {}
};

const VIEWPORT = (ws: string) => `cockpit.canvasViewport.${ws}`;
const readViewport = (ws: string): Viewport | undefined => {
  try {
    return JSON.parse(localStorage.getItem(VIEWPORT(ws)) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
};
// another screen keeps its own place on each workspace, and its own workspace
const SCREEN_WS = "cockpit.canvasScreenWorkspace";
const screenKey = (ws: string, screen?: string) => (screen ? `${ws}.screen` : ws);
const savedScreenWs = () => {
  try {
    return localStorage.getItem(SCREEN_WS) ?? undefined;
  } catch {
    return undefined;
  }
};
const writeViewport = (ws: string, v: Viewport) => {
  try {
    localStorage.setItem(VIEWPORT(ws), JSON.stringify(v));
  } catch {}
};

// screen: this window is the canvas on another screen, opened from the window it names (see lib/screens.ts)
function Board({ focus, ticket, switcher, screen }: { focus?: string; ticket?: string; switcher: ReactNode; screen?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const flow = useReactFlow<CardNode, LinkEdgeT>();
  const canvases = useCanvases();
  const terms = useTerms();
  const live = useLiveSessions();
  const worktrees = useWorktrees();
  const tracker = !!useAppConfig().data?.tracker;
  const copyOnSelect = useCopyOnSelect();
  const [picking, setPicking] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState(() => (screen ? (savedScreenWs() ?? savedWorkspace()) : savedWorkspace()));
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
    if (!screen) return saveWorkspace(id);
    try {
      localStorage.setItem(SCREEN_WS, id);
    } catch {}
  };
  // the other screens open from this window (or the one this was opened from), and what each shows
  const multi = useScreens({ group: screen ?? screenGroup(), wrap, current: () => ({ ws: wsRef.current?.id, vp: flow.getViewport() }) });
  const byId = useMemo(() => new Map((terms.data ?? []).map((t) => [t.id, t])), [terms.data]);
  const sessionOf = (t: TermInfo) => live.find((x) => x.id === t.session || x.term === t.id || (!!t.pid && x.pid === t.pid && (t.node ?? "local") === (x.node ?? "local")));
  const titleOf = (t: TermInfo) => {
    const s = sessionOf(t);
    return s?.title || s?.name || t.title;
  };
  // what's folded into an archived terminal, by name
  const foldedInto = (head: string) =>
    (ws?.nodes ?? [])
      .filter((x) => x.archived?.head === head && x.id !== head)
      .map((x) => {
        if (x.kind === "term") {
          const t = byId.get(x.ref);
          return t ? titleOf(t) : "a terminal";
        }
        return x.kind === "ticket" ? x.ref : { note: "Note", changes: "Changes", runs: "Runs", plan: "Plan" }[x.kind];
      });

  // The lines: the ones you drew, and cockpit's own from each ticket to the terminals running in its worktree.
  // A line to a terminal that's working right now moves.
  const links = useMemo(() => {
    if (!ws) return [];
    const cards = new Map(ws.nodes.map((n) => [n.id, n]));
    const shown = (id: string) => {
      const n = cards.get(id);
      return !!n && !folded(n) && (n.kind !== "term" || byId.has(n.ref));
    };
    const busy = (id: string) => {
      const n = cards.get(id);
      const t = n?.kind === "term" ? byId.get(n.ref) : undefined;
      return !!t && sessionOf(t)?.status === "busy";
    };
    const nameOf = (id: string) => {
      const n = cards.get(id);
      const t = n?.kind === "term" ? byId.get(n.ref) : undefined;
      return t && titleOf(t);
    };
    // a relaying line points the way turns go
    const arrow = { type: MarkerType.ArrowClosed, color: "var(--cobalt)", width: 16, height: 16 };
    const out: LinkEdgeT[] = ws.edges
      .filter((e) => shown(e.source) && shown(e.target))
      .map((e) => {
        const a = nameOf(e.source);
        const b = nameOf(e.target);
        const from = e.relay?.from;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "link",
          markerEnd: from === "source" || from === "both" ? arrow : undefined,
          markerStart: from === "target" || from === "both" ? arrow : undefined,
          data: { kind: kindOf(cards.get(e.source)?.kind, cards.get(e.target)?.kind), live: busy(e.source) || busy(e.target), relay: e.relay, hops: e.hops, status: e.status, names: a && b ? [a, b] : undefined },
        };
      });
    const drawn = new Set(out.flatMap((e) => [`${e.source}|${e.target}`, `${e.target}|${e.source}`]));
    for (const tk of ws.nodes.filter((n) => n.kind === "ticket")) {
      const wt = worktrees.data?.find((w) => w.ticket === tk.ref && !w.main);
      if (!wt) continue;
      for (const tn of ws.nodes) {
        const t = tn.kind === "term" ? byId.get(tn.ref) : undefined;
        if (!t || (t.node ?? "local") !== (wt.node ?? "local") || !within(t.cwd, wt.path) || drawn.has(`${tk.id}|${tn.id}`)) continue;
        out.push({ id: `auto-${tk.id}-${tn.id}`, source: tk.id, target: tn.id, type: "link", deletable: false, data: { kind: "work", auto: true, live: busy(tn.id) } });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, byId, live, worktrees.data]);
  // every terminal waiting on you, on any workspace, in the order they sit; the toolbar steps through them
  const waiting = list.flatMap((c) =>
    c.nodes
      .filter((n) => {
        const t = n.kind === "term" ? byId.get(n.ref) : undefined;
        return !!t && sessionOf(t)?.status === "waiting";
      })
      .map((n) => ({ canvas: c.id, node: n })),
  );
  // A card brought up on its own: in the middle, as big as fits with room around it (about an eighth of the view
  // on each side), and never past 100%, so what's beside it still shows
  const frame = (b: { x: number; y: number; w: number; h: number }) => {
    const r = wrap.current?.getBoundingClientRect();
    const room = 0.75;
    const zoom = r ? Math.min(1, (r.width * room) / b.w, (r.height * room) / b.h) : 1;
    flow.setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom: Math.max(zoom, 0.2), duration: 250 });
  };
  const boxOf = (n: CardNode) => ({ x: n.position.x, y: n.position.y, w: n.width ?? n.measured?.width ?? TERM_W, h: n.height ?? n.measured?.height ?? TERM_H });
  // The next terminal waiting on you, selected and brought up, so its menu answers from the keys: the one after the
  // card you're on (or after: the one just answered, which may still say it's waiting), wrapping round
  const goWaiting = (after?: string) => {
    const from = after ?? nodesRef.current.find((n) => n.selected)?.id;
    const rest = waiting.filter((w) => w.node.id !== after);
    if (!rest.length) return;
    const i = waiting.findIndex((w) => w.node.id === from);
    const w = (i >= 0 ? [...waiting.slice(i + 1), ...waiting.slice(0, i + 1)] : waiting).find((x) => x.node.id !== after) ?? rest[0];
    // out of any terminal, so the keys that answer reach the canvas
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest(".xterm")) document.activeElement.blur();
    goTo(w.canvas, w.node, true);
  };
  // Going to a card: its workspace, the card selected and brought into view. framed: fitted with room around it (a
  // card at the top, the recap); otherwise at the zoom you're at, a little closer if you're far out (the finder, keys)
  const goTo = (canvas: string, card: CanvasNode, framed = false) => {
    // a card folded into an archived terminal is found at that terminal's card
    const node = (folded(card) && list.find((c) => c.id === canvas)?.nodes.find((n) => n.id === card.archived!.head)) || card;
    const go = () => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === node.id })));
      if (framed) frame(node);
      else flow.setCenter(node.x + node.w / 2, node.y + node.h / 2, { zoom: Math.max(flow.getZoom(), 0.6), duration: 250 });
    };
    if (canvas !== ws?.id) {
      shownWs.current = canvas;
      pick(canvas);
      setTimeout(go, 80);
    } else go();
  };
  // Coming back to a workspace after a while away, or to this tab: what its agents did meanwhile. While you're
  // looking, the time you last saw it moves on every half minute; once the tab is hidden it stays where you left.
  const [recap, setRecap] = useState<{ ws: string; since: number; asked: boolean }>();
  const wsId = ws?.id;
  useEffect(() => {
    if (!wsId) return;
    const id = wsId;
    const cameBack = () => {
      const seen = readSeen(id);
      if (seen && Date.now() - seen > AWAY_MS) setRecap({ ws: id, since: seen, asked: false });
    };
    const mark = () => document.visibilityState === "visible" && writeSeen(id, Date.now());
    cameBack();
    mark();
    const timer = setInterval(mark, 30_000);
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      cameBack();
      mark();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      mark();
    };
  }, [wsId]);
  const [finding, setFinding] = useState(false);
  const [keysShown, setKeysShown] = useState(false);
  const [tones, setTones] = useState<Record<string, CardTone | undefined>>({});
  const [mapShown, setMapShown] = useState(readMap);
  const toggleMap = () =>
    setMapShown((v) => {
      try {
        localStorage.setItem(MAP, v ? "0" : "1");
      } catch {}
      return !v;
    });
  const ticketsQ = useTickets();
  const found: FoundCard[] = list.flatMap((c) =>
    c.nodes.flatMap((n): FoundCard[] => {
      const base = { id: n.id, canvas: c.id, workspace: c.name, kind: n.kind };
      // what's folded into an archived terminal is found by that terminal's card
      if (folded(n)) return [];
      if (n.kind === "term") {
        const t = byId.get(n.ref);
        return t ? [{ ...base, label: titleOf(t), detail: n.archived ? `archived · ${shortPath(t.cwd)}` : shortPath(t.cwd) }] : [];
      }
      if (n.kind === "ticket") return [{ ...base, label: n.ref, detail: [...(ticketsQ.data?.tickets ?? []), ...(ticketsQ.data?.epics ?? [])].find((t) => t.key === n.ref)?.summary }];
      if (n.kind === "note") return [{ ...base, label: qc.getQueryData<{ text: string }>(["note", n.id])?.text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") || "Note" }];
      return [{ ...base, label: { runs: "Runs", plan: "Plan", changes: "Changes" }[n.kind] }];
    }),
  );

  // The keys, while you aren't typing in a terminal or a box: arrows move to the nearest card that way, Enter
  // brings it up and types into its terminal, / finds a card, w the next one waiting, f fits, 1-9 workspaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest("input, textarea, select, [contenteditable], .xterm") || finding || picking) return;
      const cur = nodesRef.current;
      const sel = cur.find((n) => n.selected);
      const mid = (n: CardNode) => ({ x: n.position.x + (n.width ?? 0) / 2, y: n.position.y + (n.height ?? 0) / 2 });
      const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (dirs[e.key] && cur.length) {
        e.preventDefault();
        const [dx, dy] = dirs[e.key];
        const from = sel ? mid(sel) : (() => {
          const r = wrap.current!.getBoundingClientRect();
          return flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        })();
        // the closest card in that direction, the straighter the better
        const best = cur
          .filter((n) => n.id !== sel?.id)
          .map((n) => {
            const m = mid(n);
            const along = (m.x - from.x) * dx + (m.y - from.y) * dy;
            const across = Math.abs((m.x - from.x) * dy) + Math.abs((m.y - from.y) * dx);
            return { n, along, score: along + across * 2 };
          })
          .filter((c) => c.along > 1)
          .sort((a, b) => a.score - b.score)[0]?.n;
        const target = best ?? (!sel ? cur[0] : undefined);
        const node = target && ws?.nodes.find((x) => x.id === target.id);
        if (node && ws) goTo(ws.id, { ...node, x: target!.position.x, y: target!.position.y, w: target!.width ?? node.w, h: target!.height ?? node.h });
        return;
      }
      // talking to a terminal: v again or Enter turns it into text, Esc drops it
      const v = voice.get();
      // a v held down repeats: those keep it listening, it ends when the key comes up
      if (e.key === "v" && e.repeat) {
        e.preventDefault();
        return;
      }
      if (v.state === "listening" && (e.key === "v" || e.key === "Enter")) {
        e.preventDefault();
        voice.stop();
        return;
      }
      if (e.key === "Escape" && (v.state === "listening" || v.state === "error")) {
        e.preventDefault();
        voice.cancel();
        return;
      }
      if (e.key === "v" && sel?.type === "term") {
        e.preventDefault();
        if (e.repeat) return;
        // held down, it's push to talk: letting go stops it (see the keyup below)
        vDown.current = Date.now();
        voice.toggle(sel.id, (sel.data as TermData).term.id, voiceSend);
        return;
      }
      if (e.key === "Enter" && sel) {
        e.preventDefault();
        actions.bringUp(sel.id);
        setTimeout(() => (document.querySelector(`[data-card="${sel.type === "term" ? (sel.data as TermData).term.id : ""}"] .xterm-helper-textarea`) as HTMLElement | null)?.focus(), 300);
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        setFinding(true);
      } else if (e.key === "w") goWaiting();
      else if (e.key === "f") flow.fitView({ maxZoom: 1, padding: 0.1, duration: 250 });
      else if (e.key === "?") setKeysShown((v) => !v);
      else if (e.key === "m") toggleMap();
      // on a terminal waiting on you, the numbers answer its menu (its strip listens for them)
      else if (/^[1-9]$/.test(e.key) && sel?.type === "term" && (sel.data as TermData).status === "waiting") return;
      else if (/^[1-9]$/.test(e.key) && list[Number(e.key) - 1]) pick(list[Number(e.key) - 1].id);
    };
    // letting go of a v held for a moment ends what you're saying; a quick tap leaves it listening
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== "v" || !vDown.current) return;
      const held = Date.now() - vDown.current;
      vDown.current = 0;
      if (held > 300 && voice.get().state === "listening") voice.stop();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
    };
  });
  // A run recording right now, beside the runs card it's on: its screen shows up when it starts and goes when it
  // ends. The runs that are going come live from the socket, whatever's on screen, so this doesn't wait for the
  // runs card to be in view.
  const running = useRuns({ status: "running", limit: 50 }).data;
  const screens = useMemo(() => {
    if (!ws) return [];
    const cards = new Map(ws.nodes.map((n) => [n.id, n]));
    const out: { card: CanvasNode; runId: string; name: string; src: string; recording: boolean }[] = [];
    for (const rc of ws.nodes.filter((n) => n.kind === "runs" && !n.archived)) {
      const ends = links.filter((e) => e.source === rc.id || e.target === rc.id).map((e) => cards.get(e.source === rc.id ? e.target : e.source));
      const t = ends.map((n) => (n?.kind === "term" ? byId.get(n.ref) : undefined)).find(Boolean);
      const session = t ? sessionOf(t)?.id : undefined;
      const ticket = t ? undefined : ends.find((n) => n?.kind === "ticket")?.ref;
      // a terminal's: the ones it started, its agent ran, or that were filed under the worktree it's in (a recording
      // script says which worktree it's for, not which terminal), as its runs card lists them
      const inWorktree = (r: Run) => !!t && !!r.worktree && (r.node ?? "local") === (t.node ?? "local") && (t.cwd === r.worktree || t.cwd.startsWith(`${r.worktree}/`));
      const run = (running ?? []).find((r) => !!liveSrc(r) && (t ? r.meta.terminal === t.id || (!!session && r.meta.session === session) || inWorktree(r) : !!ticket && r.ticket === ticket));
      if (run) out.push({ card: rc, runId: run.id, name: run.name, src: liveSrc(run)!, recording: recording(run) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, links, byId, live, running]);
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<LinkEdgeT>([]);
  useEffect(
    () =>
      setEdges((prev) =>
        [...links, ...screens.map((s): LinkEdgeT => ({ id: `screen-edge-${s.card.id}`, source: s.card.id, target: `screen-${s.card.id}`, type: "link", deletable: false, data: { kind: "watch", auto: true, live: true } }))].map((e) => ({
          ...e,
          selected: prev.find((p) => p.id === e.id)?.selected,
        })),
      ),
    [links, screens, setEdges],
  );

  // what the server has, with the cards in hand left where they are
  useEffect(() => {
    if (!ws) return;
    const linked = (id: string) => links.filter((e) => (e.source === id || e.target === id) && e.data?.kind === "work").length;
    const cards = new Map(ws.nodes.map((n) => [n.id, n]));
    // a changes card shows the branch of the terminal it's linked to, or else of the ticket's worktree
    const fromOf = (id: string): ChangesFrom | undefined => {
      const ends = links.filter((e) => e.source === id || e.target === id).map((e) => cards.get(e.source === id ? e.target : e.source));
      const t = ends.map((n) => (n?.kind === "term" ? byId.get(n.ref) : undefined)).find(Boolean);
      if (t) return { term: t.id, node: t.node, label: titleOf(t), session: sessionOf(t)?.id };
      for (const n of ends) {
        const wt = n?.kind === "ticket" ? worktrees.data?.find((w) => w.ticket === n.ref && !w.main) : undefined;
        if (wt) return { root: wt.path, node: wt.node, label: n!.ref };
      }
    };
    // a runs card shows what the terminal it's linked to ran, or else the ticket's runs
    const runsOf = (id: string): RunsFrom | undefined => {
      const ends = links.filter((e) => e.source === id || e.target === id).map((e) => cards.get(e.source === id ? e.target : e.source));
      const t = ends.map((n) => (n?.kind === "term" ? byId.get(n.ref) : undefined)).find(Boolean);
      if (t) return { term: t.id, node: t.node, label: titleOf(t), session: sessionOf(t)?.id };
      const tk = ends.find((n) => n?.kind === "ticket");
      if (tk) return { ticket: tk.ref, label: tk.ref };
    };
    // a plan card shows what the agent in the terminal it's linked to is working through
    const planOf = (id: string): PlanFrom | undefined => {
      const ends = links.filter((e) => e.source === id || e.target === id).map((e) => cards.get(e.source === id ? e.target : e.source));
      const t = ends.map((n) => (n?.kind === "term" ? byId.get(n.ref) : undefined)).find(Boolean);
      const s = t && sessionOf(t);
      if (t) return { term: t.id, label: titleOf(t), session: s?.id, status: s?.status };
    };
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      const out: CardNode[] = [];
      for (const n of ws.nodes) {
        // folded into an archived terminal: out of sight until it's brought back
        if (folded(n)) continue;
        const was = old.get(n.id);
        const keep = moving.current.has(n.id) ? was : undefined;
        // a card that fits its content is left without a height, so it takes what it shows
        const base = { id: n.id, position: keep?.position ?? { x: n.x, y: n.y }, width: keep?.width ?? n.w, height: keep?.height ?? (n.fit ? undefined : n.h), initialHeight: n.h, dragHandle: ".card-handle", selected: was?.selected };
        if (n.kind === "note") {
          out.push({ ...base, type: "note", data: { fresh: n.id === fresh, fit: n.fit } });
          continue;
        }
        if (n.kind === "ticket") {
          out.push({ ...base, type: "ticket", data: { key: n.ref, terms: linked(n.id), fit: n.fit } });
          continue;
        }
        if (n.kind === "changes") {
          out.push({ ...base, type: "changes", data: { from: fromOf(n.id), fit: n.fit } });
          continue;
        }
        if (n.kind === "runs") {
          out.push({ ...base, type: "runs", data: { from: runsOf(n.id), fit: n.fit } });
          continue;
        }
        if (n.kind === "plan") {
          out.push({ ...base, type: "plan", data: { from: planOf(n.id), fit: n.fit } });
          continue;
        }
        // its terminal has closed, or its machine hasn't listed it yet
        const t = byId.get(n.ref);
        const s = t && sessionOf(t);
        const archived = n.archived?.head === n.id ? { archived: n.archived.at, folded: foldedInto(n.id) } : {};
        if (t) out.push({ ...base, ...(n.archived ? { height: n.h } : {}), type: "term", data: { term: t, title: titleOf(t), status: s?.status, session: s?.id, cost: s?.costUSD, ...archived } });
      }
      // each recording's screen to the right of its runs card, or to its left when something's there
      const clash = (b: { x: number; y: number; w: number; h: number }) => ws.nodes.some((n) => n.x < b.x + b.w && b.x < n.x + n.w && n.y < b.y + b.h && b.y < n.y + n.h);
      for (const s of screens) {
        const rc = old.get(s.card.id);
        const at = rc?.position ?? { x: s.card.x, y: s.card.y };
        const w = rc?.measured?.width ?? s.card.w;
        const right = { x: at.x + w + 40, y: at.y, w: SCREEN_W, h: SCREEN_H };
        const spot = clash(right) && !clash({ ...right, x: at.x - SCREEN_W - 40 }) ? { x: at.x - SCREEN_W - 40, y: at.y } : { x: right.x, y: right.y };
        out.push({ id: `screen-${s.card.id}`, type: "screen", position: spot, width: SCREEN_W, height: SCREEN_H, draggable: false, deletable: false, data: { runId: s.runId, name: s.name, src: s.src, recording: s.recording } });
      }
      return out;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, byId, live, fresh, links, worktrees.data, screens, setNodes]);

  // each workspace opens where you left it, or fitted the first time
  const shownWs = useRef<string>(undefined);
  useEffect(() => {
    // a link to one terminal brings that one up instead, the first time only; after that its workspace opens where you left it
    if (!ws || shownWs.current === ws.id || (focus && focused.current !== focus && ws.nodes.some((n) => n.ref === focus))) return;
    shownWs.current = ws.id;
    const saved = readViewport(screenKey(ws.id, screen));
    // where you left it, unless none of its cards would be on screen there (it was empty then, or they moved away)
    const r = wrap.current?.getBoundingClientRect();
    const seen =
      saved &&
      r &&
      ws.nodes.some((n) => {
        const left = -saved.x / saved.zoom;
        const top = -saved.y / saved.zoom;
        return n.x < left + r.width / saved.zoom && n.x + n.w > left && n.y < top + r.height / saved.zoom && n.y + n.h > top;
      });
    setTimeout(() => {
      if (saved && (seen || !ws.nodes.length)) flow.setViewport(saved);
      else flow.fitView({ maxZoom: 1, padding: 0.1 });
      multi.announce();
    }, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the workspace or the link changes
  }, [ws, focus, flow]);
  // A workspace shown while it had nothing on it (or before this page heard what was moved there) fits its cards once
  // they arrive, so the first card doesn't land somewhere off screen
  const wasEmpty = useRef<string>(undefined);
  const wsCount = ws?.nodes.length ?? 0;
  useEffect(() => {
    if (!wsId) return;
    if (!wsCount) wasEmpty.current = wsId;
    else if (wasEmpty.current === wsId) {
      wasEmpty.current = undefined;
      setTimeout(() => flow.fitView({ maxZoom: 1, padding: 0.1, duration: 250 }), 80);
    }
  }, [wsId, wsCount, flow]);

  // a link to one terminal (a session card, a notification) opens its workspace and brings it up, framed
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
    setTimeout(() => frame(boxOf(n)), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, list, ws, nodes, flow]);

  // A card at the top clicked: that terminal's card, on whichever workspace, selected and framed, every time
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(
    () =>
      onFocusRequest(({ kind, ref }) => {
        const home = listRef.current.find((c) => c.nodes.some((n) => n.kind === kind && n.ref === ref));
        const node = home?.nodes.find((n) => n.kind === kind && n.ref === ref);
        if (home && node) goToRef.current(home.id, node, true);
      }),
    [],
  );
  // and which terminal is selected here, for the strip to mark
  const selectedTerm = nodes.find((n) => n.selected && n.type === "term") as TermCardNode | undefined;
  const selectedId = selectedTerm?.data.term.id;
  useEffect(() => setCanvasSelected(selectedId), [selectedId]);
  useEffect(() => () => setCanvasSelected(undefined), []);

  // "Open on canvas" from a ticket: its card, put on this workspace if it isn't on one yet, and brought into view
  const ticketDone = useRef<string>(undefined);
  const ticketAsked = useRef<string>(undefined);
  useEffect(() => {
    if (!ticket || ticketDone.current === ticket || !list.length || !ws) return;
    const home = list.find((c) => c.nodes.some((n) => n.kind === "ticket" && n.ref === ticket));
    if (!home) {
      if (ticketAsked.current === ticket) return;
      ticketAsked.current = ticket;
      guard(api.post(`/canvas/${ws.id}/tickets`, { key: ticket, ...centre(TICKET_W, TICKET_H), by: tabId }).then(refresh));
      return;
    }
    if (home.id !== ws.id) return pick(home.id);
    const n = nodes.find((x) => x.type === "ticket" && x.data.key === ticket);
    if (!n) return;
    ticketDone.current = ticket;
    shownWs.current = home.id;
    setTimeout(() => flow.setCenter(n.position.x + (n.width ?? TICKET_W) / 2, n.position.y + (n.height ?? TICKET_H) / 2, { zoom: Math.max(flow.getZoom(), 0.8), duration: 250 }), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket, list, ws, nodes, flow]);

  // once a drag or resize ends, the new place goes to the server and to the cached copy at once. A card that fit
  // its content and was given another height by hand keeps that height from then on (dragging only its width
  // doesn't count); from: each resized card's height when the resize started.
  const commit = (ids: string[], from = new Map<string, number>()) =>
    setTimeout(() => {
      const cur = wsRef.current;
      if (!cur) return;
      const boxes = nodesRef.current
        .filter((n) => ids.includes(n.id))
        .map((n) => {
          const h = n.height ?? n.measured?.height ?? TERM_H;
          const start = from.get(n.id);
          return { id: n.id, x: n.position.x, y: n.position.y, w: n.width ?? n.measured?.width ?? TERM_W, h, ...(start !== undefined && n.type !== "term" && Math.abs(h - start) > 4 ? { fit: false } : {}) };
        });
      const at = new Map(boxes.map((b) => [b.id, b]));
      qc.setQueryData<CanvasInfo[]>(["canvas"], (old) => old?.map((c) => (c.id !== cur.id ? c : { ...c, nodes: c.nodes.map((n) => ({ ...n, ...at.get(n.id) })) })));
      ids.forEach((i) => moving.current.delete(i));
      api.put(`/canvas/${cur.id}/layout`, { nodes: boxes, by: tabId }).catch((e) => {
        setErr(e);
        qc.invalidateQueries({ queryKey: ["canvas"] });
      });
    }, 50);

  // the height each card had when you started resizing it
  const sizedFrom = useRef(new Map<string, number>());
  // a card that fits its content tells the server its height once it settles, so new cards go clear of it
  const grown = useRef(new Set<string>());
  const growTimer = useRef(0);
  const grew = (id: string) => {
    if (!wsRef.current?.nodes.find((n) => n.id === id)?.fit || moving.current.has(id)) return;
    grown.current.add(id);
    clearTimeout(growTimer.current);
    growTimer.current = window.setTimeout(() => {
      const stored = new Map(wsRef.current?.nodes.map((n) => [n.id, n.h]));
      const ids = [...grown.current].filter((i) => {
        const n = nodesRef.current.find((x) => x.id === i);
        const h = n?.measured?.height;
        return !!h && Math.abs(h - (stored.get(i) ?? 0)) > 8;
      });
      grown.current.clear();
      if (ids.length) commit(ids);
    }, 1500);
  };
  const onNodesChange = (changes: NodeChange<CardNode>[]) => {
    // cards only leave through their own buttons
    applyChanges(changes.filter((c) => c.type !== "remove"));
    const ended: string[] = [];
    for (const c of changes) {
      if (c.type !== "position" && c.type !== "dimensions") continue;
      if (c.type === "dimensions" && c.resizing === undefined) {
        grew(c.id);
        continue;
      }
      const busy = c.type === "position" ? c.dragging : c.resizing;
      if (c.type === "dimensions" && c.resizing && !sizedFrom.current.has(c.id)) {
        const n = nodesRef.current.find((x) => x.id === c.id);
        sizedFrom.current.set(c.id, n?.height ?? n?.measured?.height ?? 0);
      }
      if (busy) moving.current.add(c.id);
      else if (busy === false) ended.push(c.id);
    }
    if (ended.length) {
      const from = new Map(ended.flatMap((i) => (sizedFrom.current.has(i) ? [[i, sizedFrom.current.get(i)!] as const] : [])));
      ended.forEach((i) => sizedFrom.current.delete(i));
      commit(ended, from);
    }
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
  const addTicket = (key: string, all = false, kind?: string) => {
    setPicking(false);
    if (!ws) return;
    const there = ws.nodes.find((n) => n.kind === "ticket" && n.ref === key);
    if (there) return all ? guard(setupTicket(there.id, kind)) : show(there);
    guard(
      api.post<CanvasNode>(`/canvas/${ws.id}/tickets`, { key, ...centre(TICKET_W, TICKET_H), by: tabId }).then(async (n) => {
        await refresh();
        show(n);
        if (all) await setupTicket(n.id, kind);
      }),
    );
  };
  // a changes card in the middle of the screen, for you to link to a terminal or a ticket; one with a card selected
  // goes under that card, already linked to it
  const newChanges = () => {
    if (!ws) return;
    const sel = nodesRef.current.find((n) => n.selected && (n.type === "term" || n.type === "ticket"));
    guard(
      api.post<{ node: CanvasNode }>(`/canvas/${ws.id}/changes`, { ...centre(CHANGES_W, CHANGES_H), link: sel?.id, by: tabId }).then(async ({ node }) => {
        await refresh();
        show(node);
      }),
    );
  };
  // the same for a runs card
  const newRuns = () => {
    if (!ws) return;
    const sel = nodesRef.current.find((n) => n.selected && (n.type === "term" || n.type === "ticket"));
    guard(
      api.post<{ node: CanvasNode }>(`/canvas/${ws.id}/runs`, { ...centre(RUNS_W, RUNS_H), link: sel?.id, by: tabId }).then(async ({ node }) => {
        await refresh();
        show(node);
      }),
    );
  };
  // the same for a plan card, for the terminal selected
  const newPlan = () => {
    if (!ws) return;
    const sel = nodesRef.current.find((n) => n.selected && n.type === "term");
    guard(
      api.post<{ node: CanvasNode }>(`/canvas/${ws.id}/plan`, { ...centre(PLAN_W, PLAN_H), link: sel?.id, by: tabId }).then(async ({ node }) => {
        await refresh();
        show(node);
      }),
    );
  };
  // Started from a ticket card: once the new terminal is on the canvas (the server places it beside the ticket),
  // a changes card and a runs card go under it, linked, unless that ticket's work already has them.
  // a terminal just opened, once its card is on this workspace (the server places it as it lists the terminal)
  const cardOf = async (term: string) => {
    const wsId = wsRef.current?.id;
    for (let i = 0; wsId && i < 30; i++) {
      const cur = (await qc.fetchQuery({ queryKey: ["canvas"], queryFn: () => api.get<CanvasInfo[]>("/canvas"), staleTime: 0 })).find((c) => c.id === wsId);
      const card = cur?.nodes.find((n) => n.kind === "term" && n.ref === term);
      if (cur && card) return { cur, card };
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const started = async (ticketNode: string, term: string) => {
    const wsId = wsRef.current?.id;
    if (!wsId) return;
    {
      const found = await cardOf(term);
      if (found) {
        const { cur, card } = found;
        const near = new Set([ticketNode, ...cur.edges.filter((e) => e.source === ticketNode || e.target === ticketNode).flatMap((e) => [e.source, e.target])]);
        const watched = (kind: "changes" | "runs") =>
          cur.edges.some((e) => {
            const other = near.has(e.source) ? e.target : near.has(e.target) ? e.source : undefined;
            return other && cur.nodes.find((n) => n.id === other)?.kind === kind;
          });
        for (const kind of ["changes", "runs"] as const) if (!watched(kind)) await guard(api.post(`/canvas/${wsId}/${kind}`, { link: card.id, by: tabId }));
        await refresh();
      }
    }
  };
  // What to open beside a card: shown where a line from it was let go over empty canvas, or under its + button.
  // at: where the new card goes (beside the card when not said).
  const agent = useAgentName();
  const [spawning, setSpawning] = useState<{ from: string; x: number; y: number; at?: { x: number; y: number } }>();
  const spawnOptions = (fromId: string): SpawnOption[] => {
    const n = ws?.nodes.find((x) => x.id === fromId);
    if (n?.kind === "ticket") {
      const noWt = worktrees.data?.some((w) => w.ticket === n.ref && !w.main) ? undefined : "No worktree yet: make one from the card first";
      return [
        { kind: "setup", label: "Everything for this ticket", hint: `${noWt ? "Its worktree, " : ""}${agent}, a reviewer on its turns, and its changes and runs, laid out and linked` },
        { kind: "claude", label: `${agent} on this ticket`, hint: "In its worktree, told which ticket to work on", disabled: noWt },
        { kind: "shell", label: "Shell in its worktree", hint: "A plain terminal there", disabled: noWt },
        { kind: "changes", label: "Changes card", hint: "Its branch: the files and commits", disabled: noWt },
        { kind: "runs", label: "Runs card", hint: "Its tests, lint, e2e and CI as they run" },
      ];
    }
    return [
      { kind: "claude", label: `New ${agent}`, hint: "Linked to this terminal by a line" },
      { kind: "review", label: `${agent} to review its turns`, hint: "Each turn this one finishes goes there to review" },
      { kind: "shell", label: "New shell", hint: "A plain terminal, linked to this one" },
      { kind: "changes", label: "Changes card", hint: "The branch it's on: files and commits" },
      { kind: "runs", label: "Runs card", hint: "The tests, lint and e2e it runs, as they go" },
      { kind: "plan", label: "Plan card", hint: "What its agent is working through, and doing now" },
    ];
  };
  const spawnFrom = async (fromId: string, kind: SpawnKind, at?: { x: number; y: number }) => {
    // where it is now on the server: a card just placed may have been moved since this tab last heard
    const cur = (await qc.fetchQuery({ queryKey: ["canvas"], queryFn: () => api.get<CanvasInfo[]>("/canvas"), staleTime: 0 }).catch(() => undefined))?.find((c) => c.id === wsRef.current?.id) ?? wsRef.current;
    const from = cur?.nodes.find((x) => x.id === fromId);
    if (!cur || !from) return;
    if (kind === "setup") return setupTicket(fromId);
    // a card that watches it goes where the line was let go, or under it
    if (kind === "changes" || kind === "runs" || kind === "plan") {
      const { node } = await api.post<{ node: CanvasNode }>(`/canvas/${cur.id}/${kind}`, { ...(at ?? {}), link: at ? undefined : fromId, by: tabId });
      if (at) await api.post(`/canvas/${cur.id}/edges`, { source: fromId, target: node.id, by: tabId });
      await refresh();
      show(node);
      return;
    }
    // the folder and machine it opens on: the terminal's (where it is now, or else where it started), or the ticket's worktree
    const t = from.kind === "term" ? byId.get(from.ref) : undefined;
    const wt = from.kind === "ticket" ? worktrees.data?.find((w) => w.ticket === from.ref && !w.main) : undefined;
    const ticket = from.kind === "ticket" ? [...(ticketsQ.data?.tickets ?? []), ...(ticketsQ.data?.epics ?? [])].find((x) => x.key === from.ref) : undefined;
    const node = t?.node ?? wt?.node;
    const now = t ? (await api.get<{ cwd: string | null }>(`/code/terms/${t.id}/changes`).catch(() => ({ cwd: null }))).cwd : undefined;
    const cwd = now ?? t?.cwd ?? wt?.path;
    if (!cwd) return;
    const folder = shortPath(cwd).split("/").pop() ?? cwd;
    const open = (dir: string) =>
      kind === "shell"
        ? api.post<{ id: string }>("/code/terms", { cwd: dir, title: `shell · ${folder}`, node })
        : api.post<{ id: string }>("/claude/launch", {
            cwd: dir,
            node,
            title: from.kind === "ticket" ? from.ref : kind === "review" ? `review · ${folder}` : `${agent.toLowerCase()} · ${folder}`,
            ...(from.kind === "ticket" ? { prompt: ticket?.url ?? from.ref, ticket: from.ref } : {}),
          });
    // a shell that cd'd somewhere cockpit doesn't open terminals in: the folder it started in instead
    const made = await open(cwd).catch((e) => (t && cwd !== t.cwd ? open(t.cwd) : Promise.reject(e)));
    const card = await api.post<CanvasNode>(`/canvas/${cur.id}/terms`, { term: made.id, ...(at ?? { x: from.x + from.w + 40, y: from.y }), by: tabId });
    const edge = await api.post<{ id: string }>(`/canvas/${cur.id}/edges`, { source: fromId, target: card.id, by: tabId });
    // both ways: its turns go to the reviewer, and the review comes back to it to act on
    if (kind === "review") await api.patch(`/canvas/edges/${edge.id}`, { relay: { from: "both", role: "review", limit: 4 }, by: tabId });
    await qc.invalidateQueries({ queryKey: ["terms"] });
    await refresh();
    show(card);
  };
  // Everything for working on a ticket, in one go: its agent beside the ticket (the server puts a terminal in the
  // ticket's worktree there), a reviewer beside that on a line that passes on each turn once its checks pass, and
  // the changes and runs of its work under it. Then all of it is brought into view.
  const setupTicket = async (ticketNode: string, kind?: string) => {
    // a ticket card just put on the canvas may not be in what this tab has yet
    const fresh = async () => (await qc.fetchQuery({ queryKey: ["canvas"], queryFn: () => api.get<CanvasInfo[]>("/canvas"), staleTime: 0 })).find((c) => c.nodes.some((n) => n.id === ticketNode));
    const cur = wsRef.current?.nodes.some((n) => n.id === ticketNode) ? wsRef.current : await fresh();
    const tk = cur?.nodes.find((x) => x.id === ticketNode && x.kind === "ticket");
    if (!cur || !tk) throw new Error("That ticket's card isn't on the canvas any more");
    const ticket = [...(ticketsQ.data?.tickets ?? []), ...(ticketsQ.data?.epics ?? [])].find((x) => x.key === tk.ref);
    try {
      // a kind that writes no code works in the repo as it is, with no worktree made for it
      const kits = await api.get<KitsRes>(`/claude/kits?ticket=${encodeURIComponent(tk.ref)}`);
      const team = kits.kinds.find((x) => x.id === (kind ?? kits.matched))?.team ?? kits.fallback;
      await setupWith(cur, tk, team.worktree ? await worktreeFor(tk.ref, ticket) : undefined, kind);
    } finally {
      setSettingUp(undefined);
    }
  };
  const [scheduling, setScheduling] = useState(false);
  const scheduled = (useSchedules().data ?? []).filter((s) => s.canvas === ws?.id).length;
  const voiceSend = !!useSettings().data?.settings.terminals?.voiceSend;
  const vDown = useRef(0);
  // what's being set up for a ticket, while it is
  const [settingUp, setSettingUp] = useState<string>();
  // the ticket's worktree, made first when it has none: its job is waited on, a few minutes at most
  const worktreeFor = async (key: string, ticket?: { summary: string; type?: string }) => {
    const find = async () => (await qc.fetchQuery({ queryKey: ["worktrees"], queryFn: () => api.get<Worktree[]>("/worktrees"), staleTime: 0 })).find((w) => w.ticket === key && !w.main);
    const had = await find();
    if (had) return had;
    setSettingUp(`${key}: making its worktree`);
    const job = await api.post<{ id: string }>("/worktrees", { key, summary: ticket?.summary ?? key, type: ticket?.type });
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const j = (await api.get<Job[]>("/jobs")).find((x) => x.id === job.id);
      if (j?.code !== undefined && j.code !== 0) throw new Error(`Couldn't make ${key}'s worktree: ${j.output?.trim().split("\n").pop() ?? `it ended with ${j.code}`}`);
      const wt = j?.code === 0 || i % 4 === 3 ? await find() : undefined;
      if (wt) return wt;
    }
    throw new Error(`${key}'s worktree is taking too long: see it on the Jobs screen`);
  };
  // A kind of work's team for a ticket, laid out and linked: its terminals left to right beside the ticket (the
  // main one first), each one's cards under it, and the lines between them passing their turns along. A terminal
  // that plans first starts in plan mode, with its plan on a card beside it.
  const setupWith = async (cur: CanvasInfo, tk: CanvasNode, wt: Worktree | undefined, kind?: string) => {
    const kits = await api.get<KitsRes>(`/claude/kits?ticket=${encodeURIComponent(tk.ref)}`);
    const k = kits.kinds.find((x) => x.id === (kind ?? kits.matched));
    const team = k?.team ?? kits.fallback;
    // no worktree for this kind: the ticket's repo, as it is
    const place = wt ?? worktrees.data?.find((w) => w.main);
    if (!place) throw new Error("There's no repo to work in: add one in Settings");
    const made: string[] = [tk.id];
    const cards = new Map<string, CanvasNode>();
    let x = tk.x + tk.w + 40;
    for (const m of team.terms) {
      setSettingUp(`${tk.ref}: starting the ${m.name}`);
      const t = await api.post<{ id: string }>("/claude/launch", { cwd: place.path, node: place.node, ticket: tk.ref, kind: k?.id, member: m.id });
      await qc.invalidateQueries({ queryKey: ["terms"] });
      if (!(await cardOf(t.id))) throw new Error(`The ${m.name} started but didn't show on the canvas`);
      const card = await api.post<CanvasNode>(`/canvas/${cur.id}/terms`, { term: t.id, x, y: tk.y, by: tabId });
      cards.set(m.id, card);
      made.push(card.id);
      x = card.x + card.w + 40;
      // a terminal planning first always has its plan beside it
      const want = [...new Set([...(m.planFirst ? (["plan"] as const) : []), ...m.cards])];
      for (const c of want) made.push((await api.post<{ node: CanvasNode }>(`/canvas/${cur.id}/${c}`, { link: card.id, by: tabId })).node.id);
    }
    setSettingUp(`${tk.ref}: linking them`);
    for (const l of team.lines) {
      const a = cards.get(l.from);
      const b = cards.get(l.to);
      if (!a || !b) continue;
      const edge = await api.post<{ id: string }>(`/canvas/${cur.id}/edges`, { source: a.id, target: b.id, by: tabId });
      await api.patch(`/canvas/edges/${edge.id}`, { relay: { from: l.both ? "both" : "source", role: l.role, limit: l.limit, ...(l.when ? { when: l.when } : {}), ...(l.prompt ? { prompt: l.prompt } : {}) }, by: tabId });
    }
    await qc.invalidateQueries({ queryKey: ["terms"] });
    await refresh();
    setTimeout(() => flow.fitView({ nodes: made.map((id) => ({ id })), padding: 0.08, maxZoom: 1, duration: 300 }), 150);
  };
  // a line let go over empty canvas, from a terminal or a ticket: what to open there
  const connectEnd = (e: MouseEvent | TouchEvent, s: FinalConnectionState) => {
    if (s.toNode || !s.fromNode) return;
    const kind = ws?.nodes.find((n) => n.id === s.fromNode!.id)?.kind;
    if (kind !== "term" && kind !== "ticket") return;
    const pt = "changedTouches" in e ? e.changedTouches[0] : e;
    const p = flow.screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
    // the new card hangs off the side the line came out of
    const left = p.x < s.fromNode.position.x;
    setSpawning({ from: s.fromNode.id, x: pt.clientX, y: pt.clientY, at: { x: Math.round(left ? p.x - TERM_W : p.x), y: Math.round(p.y - TERM_H / 2) } });
  };
  // a line drawn from one card's dot to another's
  const connect = (c: Connection) => {
    if (!ws || !c.source || !c.target || c.source === c.target) return;
    guard(api.post(`/canvas/${ws.id}/edges`, { source: c.source, target: c.target, by: tabId }).then(refresh));
  };
  const onEdgesChange = (changes: EdgeChange<LinkEdgeT>[]) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"));
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
    otherScreen: (() => {
      const p = multi.peers.find((x) => x.w > 0);
      if (!p) return undefined;
      return p.ws === ws?.id ? "here" : (list.find((c) => c.id === p.ws)?.name ?? "another workspace");
    })(),
    toScreen: (node) => {
      const peer = multi.peers.find((p) => p.w > 0);
      if (!peer || !ws) return;
      const mid = middleOf(peer);
      guard(api.post(`/canvas/${peer.ws}/group`, { nodes: withFolded(linkedTo(node, ws.nodes, links), ws.nodes), x: mid.x, y: mid.y, by: tabId }).then(refresh));
    },
    nextWaiting: (after) => goWaiting(after),
    pin: (node, from, text) => {
      const cur = wsRef.current;
      const card = nodesRef.current.find((n) => n.id === node);
      if (!cur || !card) return;
      // a fence the text itself doesn't use, so it shows as it was
      const fence = text.includes("```") ? "~~~" : "```";
      const at = { x: card.position.x + (card.width ?? TERM_W) + 40, y: card.position.y };
      guard(
        api.post<CanvasNode>(`/canvas/${cur.id}/notes`, { ...at, text: `${from}\n\n${fence}\n${text}\n${fence}\n`, by: tabId }).then(async (n) => {
          await api.post(`/canvas/${cur.id}/edges`, { source: node, target: n.id, by: tabId });
          await refresh();
          show(n);
        }),
      );
    },
    bringUp: (id) => {
      const n = flow.getNode(id);
      if (n) frame(boxOf(n));
    },
    move: (term, to) => {
      const card = ws?.nodes.find((n) => n.kind === "term" && n.ref === term);
      if (!ws || !card) return;
      guard(api.post(`/canvas/${to}/group`, { nodes: withFolded(linkedTo(card.id, ws.nodes, links), ws.nodes), by: tabId }).then(refresh));
    },
    close: (term) => guard(api.del(`/code/terms/${term}`).then(() => qc.invalidateQueries({ queryKey: ["terms"] }))),
    archive: (node, on) => {
      if (!ws) return;
      guard(api.post(`/canvas/nodes/${node}/archive`, on ? { nodes: linkedTo(node, ws.nodes, links), by: tabId } : { archived: false, by: tabId }).then(refresh));
    },
    // just this once: the view set in Settings stays the canvas
    openTab: (term) => navigate({ to: "/terminals", search: { id: term, view: "tabs" } }),
    removeNote: (node) => {
      if (!confirm("Delete this note?")) return;
      qc.setQueryData<CanvasInfo[]>(["canvas"], (old) => old?.map((c) => ({ ...c, nodes: c.nodes.filter((n) => n.id !== node) })));
      guard(api.del(`/canvas/nodes/${node}?by=${tabId}`));
    },
    removeCard: (node) => {
      qc.setQueryData<CanvasInfo[]>(["canvas"], (old) => old?.map((c) => ({ ...c, nodes: c.nodes.filter((n) => n.id !== node), edges: c.edges.filter((e) => e.source !== node && e.target !== node) })));
      guard(api.del(`/canvas/nodes/${node}?by=${tabId}`));
    },
    spawn: (node, anchor) => setSpawning({ from: node, x: anchor.left, y: anchor.bottom + 4 }),
    handOff: (edge, from, ask) => api.post(`/canvas/edges/${edge}/handoff`, { from, ask, by: tabId }).then(refresh),
    setRelay: (edge, relay) => {
      qc.setQueryData<CanvasInfo[]>(["canvas"], (old) => old?.map((c) => ({ ...c, edges: c.edges.map((e) => (e.id === edge ? { ...e, relay: relay ?? undefined, hops: 0 } : e)) })));
      guard(api.patch(`/canvas/edges/${edge}`, { relay, by: tabId }).catch((e) => (refresh(), Promise.reject(e))));
    },
    removeEdge: (edge) => {
      qc.setQueryData<CanvasInfo[]>(["canvas"], (old) => old?.map((c) => ({ ...c, edges: c.edges.filter((e) => e.id !== edge) })));
      guard(api.del(`/canvas/edges/${edge}?by=${tabId}`));
    },
    started: (ticketNode, term) => void started(ticketNode, term),
    setup: (ticketNode, kind) => setupTicket(ticketNode, kind).catch((e) => setErr(e)),
    fail: setErr,
    tone: (node, tone) => setTones((t) => (t[node] === tone ? t : { ...t, [node]: tone })),
    fit: (node) => {
      const cur = wsRef.current;
      const n = nodesRef.current.find((x) => x.id === node);
      if (!cur || !n) return;
      const box = { id: node, x: n.position.x, y: n.position.y, w: n.width ?? n.measured?.width ?? RUNS_W, h: n.height ?? n.measured?.height ?? RUNS_H, fit: true };
      qc.setQueryData<CanvasInfo[]>(["canvas"], (old) => old?.map((c) => (c.id !== cur.id ? c : { ...c, nodes: c.nodes.map((x) => (x.id === node ? { ...x, fit: true } : x)) })));
      guard(api.put(`/canvas/${cur.id}/layout`, { nodes: [box], by: tabId }));
    },
  };
  // the colour of each card on the minimap, and whether it pulses there
  // a recording's screen is red and pulses, like something failing: it's what to look at
  const mapTone = (n: CardNode): CardTone | "waiting" | undefined => (n.type === "screen" ? "fail" : n.type === "term" ? (n.data.status === "waiting" && n.data.session ? "waiting" : n.data.status === "busy" ? "running" : undefined) : tones[n.id]);
  const mapColour = (n: CardNode) => {
    const t = mapTone(n);
    if (t === "waiting") return "var(--amber)";
    if (t) return TONE_COLOUR[t];
    return n.type === "ticket" ? "color-mix(in srgb, var(--cobalt) 40%, var(--panel))" : n.type === "note" ? "var(--line)" : "var(--faint)";
  };

  return (
    <div className="h-full flex flex-col">
      {/* a screen's window has no app around it: its toolbar is the title bar, clear of the window buttons */}
      <div className={`flex items-center h-11 border-b border-line bg-panel shrink-0 ${screen ? "drag traffic overlay-gap" : ""}`}>
        {switcher && <div className="flex items-center gap-1 px-2 h-full border-r border-line shrink-0">{switcher}</div>}
        {/* first on a screen's window, so a narrow (vertical) screen doesn't push them out of sight */}
        {screen && (
          <div className="flex items-center gap-0.5 px-2 h-full border-r border-line shrink-0">
            <Button size="sm" variant="ghost" onClick={() => window.close()} title="Close this screen's window; its cards stay where they are" className="hover:!text-red">
              Close window
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void document.documentElement.requestFullscreen?.().catch(() => {})} title="This screen's canvas without the browser around it">
              Full screen
            </Button>
          </div>
        )}
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
                  {waiting.some((w) => w.canvas === c.id) && <span className="ml-1.5 inline-block size-2 rounded-full bg-amber animate-pulse align-middle" title="A terminal here is waiting on you" />}
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
          {waiting.length > 0 && (
            <button type="button" onClick={() => goWaiting()} className="h-7 px-2 rounded-md bg-amber-soft text-amber border border-amber/50 text-[13px] font-medium flex items-center gap-1.5 hover:brightness-105" title="Go to the next terminal waiting on you">
              <span className="size-2 rounded-full bg-amber animate-pulse" />
              {waiting.length} waiting
            </button>
          )}
          {settingUp && (
            <span className="flex items-center gap-1.5 px-2 text-[12px] text-cobalt shrink-0" data-setting-up>
              <span className="size-1.5 rounded-full bg-cobalt animate-pulse" />
              Setting up {settingUp}
            </span>
          )}
          <AddMenu
            options={[
              { label: "Terminal", hint: "A new terminal, from the launcher", onPick: newTerminal },
              ...(tracker ? [{ label: "Ticket", hint: "One of your tickets, to start work on and link terminals to", onPick: () => setPicking(true) }] : []),
              { label: "Note", hint: "A markdown note", onPick: newNote },
              { label: "Changes", hint: "The code changes on a branch: link it to a terminal or a ticket (or select one first)", onPick: newChanges },
              { label: "Runs", hint: "The tests, lint, e2e and CI runs of a terminal or a ticket: link it to one (or select one first)", onPick: newRuns },
              { label: "Plan", hint: "What a terminal's agent is working through and doing now: link it to one (or select one first)", onPick: newPlan },
              { label: "Scheduled agent", hint: `${agent} on its own at a time you pick, its card on this workspace${scheduled ? ` (${scheduled} here)` : ""}`, onPick: () => setScheduling(true) },
            ]}
          />
          <Button size="sm" variant="ghost" onClick={() => flow.fitView({ maxZoom: 1, padding: 0.1, duration: 250 })} title="Fit every card on screen (f)">
            Fit
          </Button>
          <Button size="sm" variant={recap ? "default" : "ghost"} onClick={() => (recap ? setRecap(undefined) : ws && setRecap({ ws: ws.id, since: Date.now() - 2 * 3600_000, asked: true }))} title="What the agents on this workspace did in the last two hours" className="hidden md:inline-flex">
            Recap
          </Button>
          <Button size="sm" variant={mapShown ? "default" : "ghost"} onClick={toggleMap} title="The map of this workspace, each card coloured by how it's doing (m)" className="hidden md:inline-flex">
            Map
          </Button>
          <Button size="sm" variant={keysShown ? "default" : "ghost"} onClick={() => setKeysShown(!keysShown)} title="The keys that move around the canvas (?)" className="hidden md:inline-flex">
            Keys
          </Button>
          <Button size="sm" variant={copyOnSelect ? "default" : "ghost"} onClick={() => termPrefs.setCopyOnSelect(!copyOnSelect)} title="Copy text as soon as you select it" className="hidden lg:inline-flex">
            Copy on select
          </Button>
          {screen ? null : (
            <Button
              size="sm"
              variant={multi.linked ? "default" : "ghost"}
              onClick={() => void openScreen(screenGroup()).then((w) => !w && setErr(new Error("The browser didn't open the window: let this page open pop-ups")))}
              title="A canvas of its own in a window for another screen: send a terminal there, with all that's linked to it, from its Move menu"
              className="hidden md:inline-flex"
              data-screens={multi.peers.length + 1}
            >
              {multi.linked ? `${multi.peers.length + 1} screens` : "Another screen"}
            </Button>
          )}
        </div>
      </div>
      <ErrorNote error={err ?? canvases.error} />
      <div ref={wrap} className="relative flex-1 min-h-0" data-testid="canvas">
        <ActionsCtx.Provider value={actions}>
          <ReactFlow
            nodes={nodes}
            onNodesChange={onNodesChange}
            nodeTypes={nodeTypes}
            edges={edges}
            onEdgesChange={onEdgesChange}
            edgeTypes={edgeTypes}
            onConnect={connect}
            onConnectEnd={connectEnd}
            connectionMode={ConnectionMode.Loose}
            connectionLineStyle={{ stroke: "var(--cobalt)", strokeWidth: 2 }}
            minZoom={0.2}
            maxZoom={2}
            onlyRenderVisibleElements
            deleteKeyCode={null}
            zoomOnDoubleClick={false}
            panOnScroll
            onMoveEnd={(_, v) => {
              if (!ws) return;
              writeViewport(screenKey(ws.id, screen), v);
              multi.announce();
            }}
            proOptions={{ hideAttribution: true }}
            className="cockpit-canvas"
          >
            {/* from the text colour, which every theme keeps readable on its background; the line colour can all but vanish */}
            <Background gap={24} size={1.5} color="color-mix(in srgb, var(--ink) 24%, transparent)" />
            <Controls showInteractive={false} />
            {mapShown && (
              <MiniMap
                pannable
                zoomable
                bgColor="var(--panel)"
                maskColor="color-mix(in srgb, var(--ground) 70%, transparent)"
                nodeColor={mapColour}
                nodeClassName={(n) => {
                  const t = mapTone(n);
                  return t ? `map-${t}` : "";
                }}
                nodeBorderRadius={6}
                className="hidden md:block canvas-map"
              />
            )}
          </ReactFlow>
        </ActionsCtx.Provider>
        {mapShown && nodes.length > 0 && (
          <div className="absolute right-[15px] bottom-[170px] z-[5] hidden md:flex items-center gap-2.5 px-2 h-6 rounded-md border border-line bg-panel/90 text-[11px] text-muted pointer-events-none" aria-label="Map colours">
            {(
              [
                ["var(--amber)", "waiting"],
                ["var(--cobalt)", "working"],
                ["var(--red)", "failing"],
                ["var(--green)", "passing"],
              ] as const
            ).map(([c, what]) => (
              <span key={what} className="flex items-center gap-1">
                <span className="size-2 rounded-sm" style={{ background: c }} />
                {what}
              </span>
            ))}
          </div>
        )}
        {spawning && (
          <SpawnMenu
            x={spawning.x}
            y={spawning.y}
            from={found.find((c) => c.id === spawning.from)?.label ?? "it"}
            options={spawnOptions(spawning.from)}
            onClose={() => setSpawning(undefined)}
            onPick={(kind) => {
              const s = spawning;
              setSpawning(undefined);
              guard(spawnFrom(s.from, kind, s.at));
            }}
          />
        )}
        {recap && recap.ws === ws?.id && (
          <AwayPanel
            ws={recap.ws}
            since={recap.since}
            asked={recap.asked}
            onClose={() => setRecap(undefined)}
            onGo={(term) => {
              const n = ws.nodes.find((x) => x.kind === "term" && x.ref === term);
              if (n) goTo(ws.id, n, true);
            }}
          />
        )}
        <CardFinder
          open={finding}
          cards={found}
          onClose={() => setFinding(false)}
          onPick={(c) => {
            setFinding(false);
            const n = list.find((x) => x.id === c.canvas)?.nodes.find((x) => x.id === c.id);
            if (n) goTo(c.canvas, n);
          }}
        />
        {keysShown && (
          <div className="absolute top-3 right-3 z-10 w-64 rounded-lg border border-line bg-raised shadow-lg p-3 text-[12px]" role="note" aria-label="Canvas keys">
            <div className="flex items-center mb-2">
              <span className="font-medium text-[13px]">Keys on the canvas</span>
              <button type="button" onClick={() => setKeysShown(false)} className="ml-auto size-5 rounded text-faint hover:text-ink" aria-label="Hide the keys">
                ×
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {[
                ["← ↑ → ↓", "the nearest card that way"],
                ["Enter", "bring it up and type into its terminal"],
                ["/", "find any card"],
                ["w", "the next terminal waiting on you; its menu's numbers answer it, then on to the next"],
                ["v", "talk to the terminal selected: v again to have it typed in"],
                ["f", "fit every card on screen"],
                ["m", "the map, coloured by how each card is doing"],
                ["1–9", "a workspace (on one waiting on you: its answer)"],
                ["?", "these keys"],
              ].map(([k, what]) => (
                <div key={k} className="contents">
                  <dt>
                    <kbd className="font-mono text-[11px] px-1 rounded border border-line bg-ground">{k}</kbd>
                  </dt>
                  <dd className="text-muted">{what}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-faint">They work while you aren't typing in a terminal: click the canvas to leave one.</p>
          </div>
        )}
        {ws && <Schedules open={scheduling} onClose={() => setScheduling(false)} workspace={ws.id} workspaceName={ws.name} />}
        <TicketPicker open={picking} onClose={() => setPicking(false)} onPick={addTicket} placed={new Set(list.flatMap((c) => c.nodes.filter((n) => n.kind === "ticket").map((n) => n.ref)))} />
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

export function TermCanvas({ focus, ticket, switcher, screen }: { focus?: string; ticket?: string; switcher: ReactNode; screen?: string }) {
  return (
    <ReactFlowProvider>
      <Board focus={focus} ticket={ticket} switcher={switcher} screen={screen} />
    </ReactFlowProvider>
  );
}
