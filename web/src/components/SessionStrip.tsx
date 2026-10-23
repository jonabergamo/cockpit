import { useEffect, useRef, useState } from "react";
import type { Session } from "@cockpit/shared";
import { useLiveSessions } from "../lib/live";
import { ago, shortPath, usd } from "../lib/format";
import { useCost } from "../lib/cost";
import { useOpenSession } from "../lib/openSession";
import { statusLook } from "../lib/status";
import { ReplyPanel } from "./ReplyPanel";
import { Button, Modal } from "./ui";

function label(s: Session) {
  return s.title || s.name || shortPath(s.cwd);
}

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

// Where it runs: the worktree's name and its repo, or the folder, plus the branch when it says more than main.
function place(s: Session) {
  const folder = s.worktree ? `${base(s.worktree.slice(0, s.worktree.lastIndexOf("/")))} · ${base(s.worktree)}` : base(s.cwd);
  const branch = s.branch && !["main", "master", "HEAD"].includes(s.branch) && !folder.includes(s.branch) ? s.branch : undefined;
  return { folder, branch };
}

// Fires a browser notification when a session asks you something: a question, a permission prompt, a dialog.
function useIdleAlerts(sessions: Session[]) {
  const prev = useRef(new Map<string, string>());
  useEffect(() => {
    const before = prev.current;
    for (const s of sessions) {
      if (before.has(s.id) && before.get(s.id) !== "waiting" && s.status === "waiting" && document.visibilityState !== "visible" && Notification.permission === "granted") {
        new Notification(`${label(s)} needs you`, { body: s.ticket ? `${s.ticket} · ${shortPath(s.cwd)}` : shortPath(s.cwd), tag: s.id });
      }
    }
    prev.current = new Map(sessions.map((s) => [s.id, s.status]));
    const waiting = sessions.filter((s) => s.status === "waiting").length;
    const busy = sessions.filter((s) => s.status === "busy").length;
    document.title = busy || waiting ? `(${busy}·${waiting}) cockpit` : "cockpit";
  }, [sessions]);
}

export function SessionStrip() {
  const cost = useCost();
  const sessions = useLiveSessions();
  const openSession = useOpenSession();
  const [opening, setOpening] = useState<string>();
  const [replying, setReplying] = useState<Session>();
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

  // what needs you first, then what's working, then what's idle
  const rank = (s: Session) => (s.status === "waiting" ? 2 : s.status === "busy" ? 1 : 0);
  const sorted = [...sessions].sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt);

  return (
    <div className="drag overlay-gap flex items-stretch gap-2 overflow-x-auto px-4 py-2 border-b border-line bg-panel min-h-[74px]">
      {sorted.length === 0 && <div className="text-muted self-center">No Claude sessions running.</div>}
      {sorted.map((s) => {
        const where = place(s);
        const look = statusLook(s.status, s.waitingFor, s.background);
        return (
        <div key={s.id} className="relative shrink-0 group/card">
        <button
          onClick={() => open(s)}
          disabled={opening === s.id}
          className={`group text-left relative overflow-hidden w-[250px] rounded-md border pl-3 pr-2 py-1.5 bg-raised hover:border-faint ${
            look.border
          } ${s.status === "busy" && !s.background ? "sweep" : ""}`}
          title={`${label(s)}\n${[s.ticket, shortPath(s.cwd), s.branch].filter(Boolean).join(" · ")}\nClick to open it in a terminal`}
        >
          <span className={`absolute left-0 top-0 bottom-0 w-1 ${look.dot} ${s.status === "idle" ? "opacity-50" : ""}`} />
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-[13px] flex-1">{label(s)}</span>
            {s.costUSD && !cost.hidden ? <span className="text-[11px] text-muted" title={`${cost.label}. ${cost.hint}`}>{usd(s.costUSD)}</span> : null}
          </div>
          <div className="flex items-center gap-1.5 text-[12px] text-ink/80 min-w-0">
            {s.ticket && <span className="shrink-0 rounded bg-ground px-1 font-mono text-[11px] text-ink">{s.ticket}</span>}
            <span className={`truncate ${where.branch ? "shrink-0 max-w-[60%]" : ""}`}>{where.folder}</span>
            {where.branch && <span className="truncate text-faint font-mono text-[11px]">{where.branch}</span>}
          </div>
          <div className="flex items-center gap-1.5 text-[12px] text-muted">
            <span className={look.text} title={look.hint}>{opening === s.id ? "opening" : look.label}</span>
            <span className="truncate ml-auto">{ago(s.updatedAt)}</span>
          </div>
        </button>
        {s.status !== "busy" && (
          <button
            onClick={() => setReplying(s)}
            className={`absolute right-1.5 bottom-1.5 rounded px-1.5 text-[11px] leading-5 ${s.status === "waiting" ? "bg-amber-soft text-amber" : "bg-ground text-muted"} opacity-0 group-hover/card:opacity-100 focus:opacity-100 max-md:opacity-100`}
            title="Answer it from here"
          >
            Reply
          </button>
        )}
        </div>
        );
      })}
      <Modal open={!!replying} onClose={() => setReplying(undefined)} title={replying ? label(replying) : ""} wide>
        {replying && (
          <div className="space-y-3">
            <ReplyPanel session={sessions.find((x) => x.id === replying.id) ?? replying} onSent={() => {}} />
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => (setReplying(undefined), open(replying))}>
                Open its terminal
              </Button>
            </div>
          </div>
        )}
      </Modal>
      {err && <span className="shrink-0 self-center text-[12px] text-red">{err}</span>}
      {perm === "default" && (
        <button onClick={() => Notification.requestPermission().then(setPerm)} className="shrink-0 self-center text-[12px] text-cobalt hover:underline ml-auto">
          Notify me when a session waits
        </button>
      )}
    </div>
  );
}
