import { useEffect, useRef, useState } from "react";
import type { Session } from "@cockpit/shared";
import { useLiveSessions } from "../lib/live";
import { ago, shortPath, usd } from "../lib/format";
import { useCost } from "../lib/cost";
import { useOpenSession } from "../lib/openSession";

function label(s: Session) {
  return s.title || s.name || shortPath(s.cwd);
}

// Fires a browser notification when a session stops working, which usually means it's waiting on me.
function useIdleAlerts(sessions: Session[]) {
  const prev = useRef(new Map<string, string>());
  useEffect(() => {
    const before = prev.current;
    for (const s of sessions) {
      if (before.get(s.id) === "busy" && s.status === "idle" && document.visibilityState !== "visible" && Notification.permission === "granted") {
        new Notification(`${label(s)} needs you`, { body: s.ticket ? `${s.ticket} · ${shortPath(s.cwd)}` : shortPath(s.cwd), tag: s.id });
      }
    }
    prev.current = new Map(sessions.map((s) => [s.id, s.status]));
    const waiting = sessions.filter((s) => s.status === "idle").length;
    const busy = sessions.filter((s) => s.status === "busy").length;
    document.title = busy || waiting ? `(${busy}·${waiting}) cockpit` : "cockpit";
  }, [sessions]);
}

export function SessionStrip() {
  const cost = useCost();
  const sessions = useLiveSessions();
  const openSession = useOpenSession();
  const [opening, setOpening] = useState<string>();
  const [err, setErr] = useState<string>();
  const open = async (s: Session) => {
    setOpening(s.id);
    setErr(undefined);
    try {
      await openSession(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(undefined);
    }
  };
  const [perm, setPerm] = useState(typeof Notification !== "undefined" ? Notification.permission : "denied");
  useIdleAlerts(sessions);

  const sorted = [...sessions].sort((a, b) => Number(b.status === "busy") - Number(a.status === "busy") || b.updatedAt - a.updatedAt);

  return (
    <div className="drag overlay-gap flex items-stretch gap-2 overflow-x-auto px-4 py-2 border-b border-line bg-panel min-h-[58px]">
      {sorted.length === 0 && <div className="text-muted self-center">No Claude sessions running.</div>}
      {sorted.map((s) => (
        <button
          key={s.id}
          onClick={() => open(s)}
          disabled={opening === s.id}
          className={`group text-left relative overflow-hidden shrink-0 w-[230px] rounded-md border pl-3 pr-2 py-1.5 bg-raised hover:border-faint ${
            s.status === "busy" ? "border-cobalt/50 sweep" : "border-amber/50"
          }`}
          title={`${label(s)}\n${shortPath(s.cwd)}\nClick to open it in a terminal`}
        >
          <span className={`absolute left-0 top-0 bottom-0 w-1 ${s.status === "busy" ? "bg-cobalt" : "bg-amber"}`} />
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-[13px] flex-1">{label(s)}</span>
            {s.costUSD && !cost.hidden ? <span className="text-[11px] text-muted" title={`${cost.label}. ${cost.hint}`}>{usd(s.costUSD)}</span> : null}
          </div>
          <div className="flex items-center gap-1.5 text-[12px] text-muted">
            <span className={s.status === "busy" ? "text-cobalt" : "text-amber"}>{opening === s.id ? "opening" : s.status === "busy" ? "working" : "waiting"}</span>
            {s.ticket && <span>{s.ticket}</span>}
            <span className="truncate ml-auto">{ago(s.updatedAt)}</span>
          </div>
        </button>
      ))}
      {err && <span className="shrink-0 self-center text-[12px] text-red">{err}</span>}
      {perm === "default" && (
        <button onClick={() => Notification.requestPermission().then(setPerm)} className="shrink-0 self-center text-[12px] text-cobalt hover:underline ml-auto">
          Notify me when a session waits
        </button>
      )}
    </div>
  );
}
