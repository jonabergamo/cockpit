import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { FOCUS_LENGTHS, useFocus, useFocusActions, useFocusError, useLeft } from "../lib/focus";
import { ago } from "../lib/format";

// In the header: starts focus mode for a while or until you end it, and shows how long is left and what it's held
export function FocusButton() {
  const focus = useFocus().data;
  const act = useFocusActions();
  const error = useFocusError();
  const left = useLeft(focus?.on ? focus.until : 0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    addEventListener("mousedown", away);
    return () => removeEventListener("mousedown", away);
  }, [open]);
  const on = !!focus?.on;
  const held = on ? focus.held.filter((h) => h.at >= focus.since).length : 0;
  const pick = (fn: () => Promise<void>) => () => (setOpen(false), void fn());
  const row = "block w-full text-left px-3 py-1.5 text-[13px] hover:bg-ground";
  return (
    <div ref={box} className="relative shrink-0 flex items-stretch border-b border-line bg-panel">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`px-3 text-[12px] whitespace-nowrap ${on ? "text-cobalt font-medium" : "text-muted hover:text-ink"} ${error ? "text-red" : ""}`}
        title={error || (on ? `Focus is on: "finished" notifications are held${focus.holdFinished ? "" : " (holding is off in Settings)"}` : "Focus: hold \"finished\" notifications until you're done")}
        aria-label="Focus mode"
      >
        {on ? `Focus · ${left || "on"}${held ? ` · ${held} held` : ""}` : "Focus"}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-40 w-60 bg-panel border border-line rounded-lg shadow-xl py-1">
          {error && <div className="px-3 py-1.5 text-[12px] text-red">{error}</div>}
          {on && (
            <button className={row} onClick={pick(act.end)}>
              End focus{held ? ` and show the ${held} held` : ""}
            </button>
          )}
          {FOCUS_LENGTHS.map((m) => (
            <button key={m} className={row} onClick={pick(() => act.start(m))}>
              {on ? "Focus" : "Focus for"} {m} minutes{on ? " from now" : ""}
            </button>
          ))}
          <button className={row} onClick={pick(() => act.start(null))}>
            Focus until I turn it off
          </button>
          <div className="px-3 pt-1.5 pb-1 text-[11px] text-faint border-t border-line mt-1">
            {focus?.holdFinished === false ? "Holding is off in Settings, so nothing is held." : "Sessions finishing wait on Today. Anything that needs you still comes through."}
          </div>
        </div>
      )}
    </div>
  );
}

// On Today: the "finished" notifications focus mode held, until you clear them
export function ReadyForYou() {
  const router = useRouter();
  const focus = useFocus().data;
  const act = useFocusActions();
  const error = useFocusError();
  if (!focus?.held.length) return null;
  return (
    <section className="bg-panel border border-line rounded-lg">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="font-semibold flex-1">Ready for you</h2>
        <span className="text-[12px] text-faint">{focus.on ? "held while you focus" : `${focus.held.length} finished while you focused`}</span>
        <button onClick={() => void act.clear()} className="text-[12px] text-cobalt hover:underline">
          Clear
        </button>
      </div>
      {error && <div className="px-4 pb-2 text-[12px] text-red">{error}</div>}
      <div className="divide-y divide-line max-h-72 overflow-y-auto">
        {focus.held.slice(0, 30).map((h) => (
          <button key={h.id} onClick={() => router.history.push(h.link)} className="block w-full text-left px-4 py-1.5 hover:bg-ground">
            <div className="flex items-center gap-2 text-[13px]">
              <span className="truncate flex-1">{h.body || h.title}</span>
              <span className="text-[11px] text-faint shrink-0">
                {h.title}
                {h.node ? ` · on ${h.node}` : ""} · {ago(h.at)}
              </span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
