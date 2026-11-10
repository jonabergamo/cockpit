import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, useInternalNode, type Edge, type EdgeProps, type InternalNode } from "@xyflow/react";
import { useState } from "react";
import type { CanvasRelay, RelayStatus } from "@cockpit/shared";
import { ago } from "../../lib/format";
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

// what the last turn did on its way along the line
const LOOK: Record<RelayStatus["state"], { pill: string; text: string; mark: string; word: string }> = {
  sent: { pill: "border-cobalt/50 bg-raised text-cobalt", text: "text-muted", mark: "↻", word: "" },
  held: { pill: "border-cobalt/50 bg-raised text-cobalt", text: "text-muted", mark: "⏸", word: "held" },
  failed: { pill: "border-red bg-red-soft text-red", text: "text-red", mark: "⚠", word: "not passed on" },
};

function StatusLine({ status }: { status: RelayStatus }) {
  return (
    <div className={`max-w-72 leading-snug ${LOOK[status.state].text}`} data-relay-status={status.state}>
      {status.state === "failed" && "⚠ "}
      {status.text} <span className="text-faint">· {ago(status.at)}</span>
    </div>
  );
}

const ROLES: { value: CanvasRelay["role"]; label: string }[] = [
  { value: "review", label: "review it" },
  { value: "plan", label: "plan from it" },
  { value: "build", label: "carry on with it" },
  { value: "custom", label: "your own words" },
];

// Once, when you say: the last answer of the agent at one end, handed to the one at the other, with what you'd like
// done with it (or just to take it into account)
function HandOff({ id, names, status, relayed }: { id: string; names: [string, string]; status?: RelayStatus; relayed: boolean }) {
  const a = useActions();
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState<"source" | "target">();
  const [err, setErr] = useState<string>();
  const go = (from: "source" | "target") => {
    setBusy(from);
    setErr(undefined);
    a.handOff(id, from, ask)
      .then(() => setAsk(""))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(undefined));
  };
  const btn = "h-6 px-2 rounded-full border border-line bg-ground hover:border-cobalt hover:text-cobalt max-w-40 truncate disabled:opacity-50";
  return (
    <div className="flex flex-col gap-1.5 p-1 border-b border-line mb-1 pb-2" data-handoff={id}>
      <span className="text-faint">Hand over the last answer</span>
      <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="and ask it to… (optional)" className="h-6 w-64 rounded bg-ground border border-line px-1.5 text-[11px] text-ink" aria-label="What to do with it" />
      <div className="flex items-center gap-1.5">
        <button type="button" disabled={!!busy} onClick={() => go("source")} className={btn} title={`What ${names[0]} said last, to ${names[1]}`}>
          {busy === "source" ? "Handing over" : `${names[0]} → ${names[1]}`}
        </button>
        <button type="button" disabled={!!busy} onClick={() => go("target")} className={btn} title={`What ${names[1]} said last, to ${names[0]}`}>
          {busy === "target" ? "Handing over" : `${names[1]} → ${names[0]}`}
        </button>
      </div>
      {err ? <div className="max-w-72 leading-snug text-red">⚠ {err}</div> : !relayed && status && <StatusLine status={status} />}
    </div>
  );
}

// A review line reviewing together with others from the same author: each gets its turn, and their reviews go back
// to it merged into one
function Panel({ id, panel, peers }: { id: string; panel?: string; peers: NonNullable<LinkData["peers"]> }) {
  const a = useActions();
  const others = peers.filter((p) => p.same).map((p) => p.name);
  if (panel)
    return (
      <div className="flex items-center gap-1.5 text-muted" data-panel={panel}>
        <span className="h-4 px-1 rounded bg-cobalt text-on-accent text-[10px] font-medium leading-4">{panel}</span>
        <span className="truncate max-w-48" title="Each gets its turn, and their reviews come back merged into one">
          Reviews together with {others.join(", ")}
        </span>
        <button type="button" onClick={() => a.joinPanel(id, null)} className="ml-auto h-6 px-1.5 rounded text-muted hover:text-ink hover:bg-ground">
          Leave
        </button>
      </div>
    );
  if (!peers.length) return null;
  return (
    <select value="" onChange={(e) => e.target.value && a.joinPanel(id, e.target.value)} className="h-6 rounded bg-ground border border-line px-1 text-[11px] text-ink" aria-label="Review together with" title="Each gets its turn, and their reviews come back merged into one">
      <option value="">Review together with…</option>
      {peers.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.panel ? ` (panel ${p.panel})` : ""}
        </option>
      ))}
    </select>
  );
}

// What a line between two terminals passes on: whose finished turns, what the other end does with them, how many
// hops before it stops for you. Changing any of it starts the count again.
function RelayControls({ id, relay, hops, status, names, panel, peers }: { id: string; relay?: CanvasRelay; hops?: number; status?: RelayStatus; names: [string, string]; panel?: string; peers?: LinkData["peers"] }) {
  const a = useActions();
  const [prompt, setPrompt] = useState(relay?.prompt ?? "");
  if (!relay)
    return (
      <button type="button" onClick={() => a.setRelay(id, { from: "both", role: "review", limit: 4 })} className="h-6 px-2 rounded-full bg-cobalt text-on-accent" title="Each turn one finishes goes on to the other">
        Relay turns
      </button>
    );
  const set = (patch: Partial<CanvasRelay>) => a.setRelay(id, { ...relay, ...patch });
  const select = "h-6 rounded bg-ground border border-line px-1 text-[11px] text-ink";
  return (
    <div className="flex flex-col gap-1.5 p-1" data-relay={id}>
      <div className="flex items-center gap-1.5">
        <select value={relay.from} onChange={(e) => set({ from: e.target.value as CanvasRelay["from"] })} className={select} aria-label="Which way it relays">
          <option value="source">
            {names[0]} → {names[1]}
          </option>
          <option value="target">
            {names[1]} → {names[0]}
          </option>
          <option value="both">both ways</option>
        </select>
        <span className="text-faint">to</span>
        <select value={relay.role} onChange={(e) => set({ role: e.target.value as CanvasRelay["role"], ...(e.target.value === "custom" ? { prompt: prompt || "Answer it." } : {}) })} className={select} aria-label="What the other end does with it">
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      {relay.role === "custom" && (
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => prompt.trim() && prompt !== relay.prompt && set({ prompt })}
          onKeyDown={(e) => e.key === "Enter" && prompt.trim() && set({ prompt })}
          placeholder="What the other end should do with it"
          className="h-6 rounded bg-ground border border-line px-1.5 text-[11px] text-ink"
          aria-label="Relay instruction"
        />
      )}
      {relay.role === "review" && (
        <label className="flex items-center gap-1.5 text-muted" title="Hand the reviewer what the turn changed in git (lock and binary files by name only), not only what the agent said it did">
          <input type="checkbox" checked={relay.withDiff !== false} onChange={(e) => set({ withDiff: e.target.checked })} className="accent-[var(--cobalt)]" aria-label="With the turn's diff" />
          with the turn's diff
        </label>
      )}
      {relay.role === "review" && <Panel id={id} panel={panel} peers={peers ?? []} />}
      <div className="flex items-center gap-1.5">
        <span className={(hops ?? 0) >= relay.limit ? "text-amber font-medium" : "text-muted"}>
          {(hops ?? 0) >= relay.limit ? `Stopped at ${relay.limit}: type into either to carry on` : `${hops ?? 0} of`}
        </span>
        {(hops ?? 0) < relay.limit && (
          <select value={relay.limit} onChange={(e) => set({ limit: Number(e.target.value) })} className={select} aria-label="Hop limit">
            {[1, 2, 3, 5, 8, 12, 20].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
        {(hops ?? 0) < relay.limit && <span className="text-muted">hops</span>}
        <select value={relay.when ?? "every"} onChange={(e) => set({ when: e.target.value as CanvasRelay["when"] })} className={select} aria-label="Which turns it passes on" title="Every turn, or only a turn after which none of its tests, lint or types are failing">
          <option value="every">every turn</option>
          <option value="passing">once checks pass</option>
        </select>
        <button type="button" onClick={() => a.setRelay(id, null)} className="ml-auto h-6 px-1.5 rounded text-muted hover:text-red hover:bg-red-soft">
          Stop relaying
        </button>
      </div>
      {status && <StatusLine status={status} />}
    </div>
  );
}

// A line between two cards. Selecting one you drew shows what it is and its × to take it away; cockpit's own (a
// terminal in its ticket's worktree) stay while that's true. A line between two terminals can relay their turns.
export function LinkEdge({ id, source, target, selected, data, markerEnd, markerStart }: EdgeProps<Edge<LinkData>>) {
  const a = useActions();
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const [path, x, y] = getBezierPath(ends(s, t));
  const kind = data?.kind ?? "talk";
  const relay = data?.relay;
  const stopped = !!relay && (data?.hops ?? 0) >= relay.limit;
  const status = data?.status;
  const at = { transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, pointerEvents: "all" as const };
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={18} markerEnd={markerEnd} markerStart={markerStart} className={`canvas-link canvas-link-${kind} ${relay ? "canvas-link-relay" : ""} ${data?.spec ? "canvas-link-spec" : ""} ${data?.live && !stopped ? "canvas-link-live" : ""} ${selected ? "canvas-link-selected" : ""}`} />
      <EdgeLabelRenderer>
        {selected ? (
          <div className="nodrag nopan absolute rounded-2xl border border-line bg-raised shadow px-2 py-1 text-[11px] text-muted" style={at}>
            <div className="flex items-center gap-1 h-5">
              <span>{data?.auto ? "runs in its worktree" : relay ? "relays turns" : data?.spec ? "📌 the note is its spec" : what[kind]}</span>
              {!data?.auto && (
                <button type="button" onClick={() => a.removeEdge(id)} className="ml-auto size-4 grid place-items-center rounded-full hover:bg-red-soft hover:text-red" aria-label="Remove this link">
                  ×
                </button>
              )}
            </div>
            {relay && !!data?.specs?.length && (
              <div className="mb-1 max-w-72 truncate text-muted" data-line-spec={id} title="Each turn goes with the spec's text; a reviewer judges the change against it">
                📌 Works to the spec: {data.specs.join(", ")}
              </div>
            )}
            {kind === "talk" && data?.names && (
              <button type="button" onClick={() => a.history(id)} className="mb-1 h-6 px-2 rounded-full border border-line bg-ground hover:border-cobalt hover:text-cobalt" data-line-history-open={id}>
                History
              </button>
            )}
            {kind === "talk" && data?.names && <HandOff id={id} names={data.names} status={data.status} relayed={!!relay} />}
            {kind === "talk" && data?.names && <RelayControls key={JSON.stringify(relay)} id={id} relay={relay} hops={data.hops} status={data.status} names={data.names} panel={data.panel} peers={data.peers} />}
          </div>
        ) : data?.spec ? (
          <span className="nodrag nopan absolute rounded-full border border-cobalt/50 bg-raised px-1 h-4 text-[10px] leading-4 text-cobalt" style={at} data-spec-line={id} title="The note is the spec of this terminal's relay lines">
            📌 spec
          </span>
        ) : (
          relay && (
            <button
              type="button"
              onClick={() => a.history(id)}
              className={`nodrag nopan absolute rounded-full border px-1.5 h-5 flex items-center gap-1 whitespace-nowrap text-[11px] tabular-nums ${status?.state === "failed" ? LOOK.failed.pill : stopped ? "border-amber bg-amber-soft text-amber" : "border-cobalt/50 bg-raised text-cobalt"}`}
              style={at}
              data-relay-pill={status?.state ?? (stopped ? "stopped" : "ok")}
              title={`${status ? `${status.text} (${ago(status.at)})` : stopped ? "Stopped at its hop limit: type into either terminal to carry on" : "Turns passed on since you last typed into either end"}.${data?.specs?.length ? ` Works to the spec: ${data.specs.join(", ")}.` : ""}${data?.panel ? ` Reviews together with the other lines marked ${data.panel}.` : ""} Click for the line's history, the line for its settings.`}
            >
              {status ? LOOK[status.state].mark : "↻"} {data?.hops ?? 0}/{relay.limit}
              {status && LOOK[status.state].word && <span>· {LOOK[status.state].word}</span>}
              {!!data?.specs?.length && (
                <span data-spec-marker={id} title={`Works to the spec: ${data.specs.join(", ")}`}>
                  📌
                </span>
              )}
              {data?.panel && (
                <span className="h-3.5 px-1 rounded bg-cobalt text-on-accent text-[10px] font-medium leading-[14px]" data-panel-badge={data.panel}>
                  {data.panel}
                </span>
              )}
            </button>
          )
        )}
      </EdgeLabelRenderer>
    </>
  );
}
