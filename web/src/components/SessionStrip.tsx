import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Session, TermInfo } from "@cockpit/shared";
import { api } from "../lib/api";
import { focusOnCanvas, focusTicketOnCanvas, savedView, useCanvasSelected, useCanvases, useStripGroup } from "../lib/canvas";
import { useLiveSessions } from "../lib/live";
import { ago, shortPath, usd } from "../lib/format";
import { useCost } from "../lib/cost";
import { useOpenSession } from "../lib/openSession";
import { useTickets, useWorktrees } from "../lib/queries";
import { statusLook } from "../lib/status";
import { ReplyPanel } from "./ReplyPanel";
import { Button, Modal } from "./ui";
import { LAST_TERMINAL, useTerms } from "../pages/Terminals";

function label(s: Session) {
  return s.title || s.name || shortPath(s.cwd);
}

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const within = (path: string, root: string) => path === root || path.startsWith(root + "/");

// Where it runs: the worktree's name and its repo, or the folder, plus the branch when it says more than main.
function place(s: Session) {
  const where = s.worktree ? `${base(s.worktree.slice(0, s.worktree.lastIndexOf("/")))} · ${base(s.worktree)}` : base(s.cwd);
  // a session on another machine says which
  const folder = s.node ? `${s.node} · ${where}` : where;
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

// a card at the top: a live session (with the terminal it runs in, when it has one) or a plain shell
type Item = { key: string; session?: Session; term?: TermInfo; ticket?: string; workspace?: string; rank: number; at: number };
type Group = { key: string; ticket?: string; workspace?: string; items: Item[] };

// The live sessions and cockpit's open terminals, one short card each, grouped by the ticket they work on (the rest
// by workspace, once there's more than one) or by workspace, as Settings says. On the canvas a card takes you to its
// terminal there; in tabs, these cards are the tabs.
export function SessionStrip() {
  const cost = useCost();
  const sessions = useLiveSessions();
  const terms = useTerms().data ?? [];
  const worktrees = useWorktrees().data ?? [];
  const tickets = useTickets().data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const groupBy = useStripGroup();
  // a pid only means the same process on the same machine
  const termOf = (s: Session) => terms.find((t) => t.id === s.term || t.session === s.id || (!!t.pid && t.pid === s.pid && (t.node ?? "local") === (s.node ?? "local")));
  // split shells show beside their terminal, not as cards of their own
  const shells = terms.filter((t) => (!t.parent || !terms.some((p) => p.id === t.parent)) && !sessions.some((s) => termOf(s)?.id === t.id));
  // the terminal open on the Terminals screen, or the parent of the split that's open there
  const path = useRouterState({ select: (r) => r.location.pathname });
  const picked = useRouterState({ select: (r) => (r.location.search as { id?: string }).id });
  const askedView = useRouterState({ select: (r) => (r.location.search as { view?: string }).view });
  // on the canvas, the card selected there; in tabs, the terminal open
  const onCanvas = path === "/terminals" && (askedView ?? savedView()) === "canvas";
  const selectedOnCanvas = useCanvasSelected();
  const canvases = useCanvases().data ?? [];
  const workspaceOf = (term?: string) => (canvases.length > 1 && term ? canvases.find((c) => c.nodes.some((n) => n.kind === "term" && n.ref === term))?.name : undefined);
  // the ticket a terminal works on: its session's, or the worktree it sits in
  const ticketOf = (cwd?: string, node?: string) => (cwd ? worktrees.find((w) => !w.main && w.ticket && (w.node ?? "local") === (node ?? "local") && within(cwd, w.path))?.ticket : undefined);
  const summaryOf = (key: string) => [...(tickets?.tickets ?? []), ...(tickets?.epics ?? [])].find((t) => t.key === key)?.summary;
  const shown = (() => {
    if (path !== "/terminals") return undefined;
    if (onCanvas) return selectedOnCanvas;
    let id = picked;
    try {
      id ??= localStorage.getItem(LAST_TERMINAL) ?? undefined;
    } catch {}
    const t = terms.find((x) => x.id === id);
    return t?.parent && terms.some((p) => p.id === t.parent) ? t.parent : id;
  })();
  const openSession = useOpenSession();
  const [opening, setOpening] = useState<string>();
  const [replying, setReplying] = useState<Session>();
  const [err, setErr] = useState<string>();
  const open = async (s: Session) => {
    setOpening(s.id);
    setErr(undefined);
    try {
      // on the canvas, its card comes into view however many times it's clicked
      focusOnCanvas(await openSession(s));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(undefined);
    }
  };
  // the open terminal's card scrolls into sight when it's off to the side
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown) strip.current?.querySelector(`[data-term="${shown}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [shown, terms.length]);
  // closes its terminal, which ends what runs in it; an agent without a terminal is ended instead
  const close = async (t: TermInfo | undefined, s?: Session) => {
    setErr(undefined);
    try {
      if (t) await api.del(`/code/terms/${t.id}`);
      else if (s) await api.post(`/agents/sessions/${s.id}/close`, {});
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    await qc.invalidateQueries({ queryKey: ["terms"] });
    if (t && t.id === shown) navigate({ to: "/terminals", search: { id: undefined }, replace: true });
  };
  const [perm, setPerm] = useState(typeof Notification !== "undefined" ? Notification.permission : "denied");
  useIdleAlerts(sessions);

  // what needs you first, then what's working, then what's idle, then the plain shells
  const rank = (s: Session) => (s.status === "waiting" ? 3 : s.status === "busy" ? 2 : 1);
  const items: Item[] = [
    ...sessions.map((s) => {
      const term = termOf(s);
      return { key: s.id, session: s, term, ticket: s.ticket || ticketOf(term?.cwd ?? s.cwd, s.node), workspace: workspaceOf(term?.id), rank: rank(s), at: s.updatedAt };
    }),
    ...shells.map((t) => ({ key: t.id, term: t, ticket: ticketOf(t.cwd, t.node), workspace: workspaceOf(t.id), rank: 0, at: t.createdAt })),
  ];
  const groups = new Map<string, Group>();
  for (const it of items) {
    const key = groupBy === "ticket" && it.ticket ? `t:${it.ticket}` : it.workspace ? `w:${it.workspace}` : "";
    const g = groups.get(key) ?? { key, ...(key.startsWith("t:") ? { ticket: it.ticket } : key ? { workspace: it.workspace } : {}), items: [] };
    g.items.push(it);
    groups.set(key, g);
  }
  // the groups with something waiting on you first; the cards nobody grouped go last
  const best = (g: Group) => Math.max(...g.items.map((i) => i.rank));
  const latest = (g: Group) => Math.max(...g.items.map((i) => i.at));
  const ordered = [...groups.values()].sort((a, b) => Number(!a.key) - Number(!b.key) || best(b) - best(a) || latest(b) - latest(a));
  for (const g of ordered) g.items.sort((a, b) => b.rank - a.rank || b.at - a.at);
  // a single group needs no heading
  const headed = ordered.length > 1 || !!ordered[0]?.key;

  const goTicket = (key: string) => {
    navigate({ to: "/terminals", search: { ticket: key, view: "canvas" } });
    focusTicketOnCanvas(key);
  };

  const card = (it: Item, g: Group) => {
    const s = it.session;
    const t = it.term;
    if (s) {
      const where = place(s);
      const look = statusLook(s.status, s.waitingFor, s.background);
      const closable = !!t || (!!s.agent && !s.term);
      // the ticket is in the group's heading; a workspace too
      const ticket = !g.ticket && it.ticket;
      return (
        <div key={it.key} data-term={t?.id} className="relative shrink-0 group/card">
          <button
            onClick={() => open(s)}
            disabled={opening === s.id}
            className={`group text-left relative overflow-hidden w-[200px] rounded-md border pl-2.5 pr-2 py-1 bg-raised hover:border-faint ${look.border} ${s.status === "busy" && !s.background ? "sweep" : ""} ${t && t.id === shown ? "ring-1 ring-cobalt" : ""}`}
            title={`${label(s)}\n${[s.ticket, where.folder, where.branch].filter(Boolean).join(" · ")}\nClick to go to its terminal`}
          >
            <span className={`absolute left-0 top-0 bottom-0 w-1 ${look.dot} ${s.status === "idle" ? "opacity-50" : ""}`} />
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium text-[13px] flex-1">{label(s)}</span>
              {s.costUSD && !cost.hidden ? (
                <span className="text-[11px] text-muted" title={`${cost.label}. ${cost.hint}`}>
                  {usd(s.costUSD)}
                </span>
              ) : null}
              {closable && <span className="w-4 shrink-0" />}
            </div>
            <div className="flex items-center gap-1.5 text-[12px] text-muted min-w-0">
              <span className={`shrink-0 ${look.text}`} title={look.hint}>
                {opening === s.id ? "opening" : look.label}
              </span>
              {ticket && <span className="shrink-0 rounded bg-ground px-1 font-mono text-[11px] text-ink">{ticket}</span>}
              {!g.workspace && it.workspace && <span className="truncate text-faint">· {it.workspace}</span>}
              <span className="truncate ml-auto shrink-0">{ago(s.updatedAt)}</span>
            </div>
          </button>
          {s.status !== "busy" && (
            <button
              onClick={() => setReplying(s)}
              className={`absolute right-1 bottom-1 rounded px-1.5 text-[11px] leading-5 ${s.status === "waiting" ? "bg-amber-soft text-amber" : "bg-ground text-muted"} opacity-0 group-hover/card:opacity-100 focus:opacity-100 max-md:opacity-100`}
              title="Answer it from here"
            >
              Reply
            </button>
          )}
          {closable && <CloseX onClick={() => close(t, s)} title={t ? "Close its terminal, which ends the session" : "End this session"} />}
        </div>
      );
    }
    return (
      <div key={it.key} data-term={t!.id} className="relative shrink-0 group/card">
        <button
          onClick={() => {
            navigate({ to: "/terminals", search: { id: t!.id } });
            focusOnCanvas(t!.id);
          }}
          className={`text-left relative overflow-hidden w-[200px] rounded-md border border-line pl-2.5 pr-2 py-1 bg-raised hover:border-faint ${t!.id === shown ? "ring-1 ring-cobalt" : ""}`}
          title={`${t!.command}\n${t!.node && t!.node !== "local" ? `on ${t!.node}: ` : ""}${t!.cwd}\nstarted ${ago(t!.createdAt)}`}
        >
          <span className={`absolute left-0 top-0 bottom-0 w-1 ${t!.state === "disconnected" ? "bg-amber" : t!.exited === undefined ? "bg-green opacity-50" : "bg-line"}`} />
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-[13px] flex-1">{t!.title}</span>
            <span className="w-4 shrink-0" />
          </div>
          <div className="flex items-center gap-1.5 text-[12px] text-muted min-w-0">
            <span className="shrink-0">{t!.state === "disconnected" ? "reconnecting" : t!.exited === undefined ? "shell" : "exited"}</span>
            <span className="truncate text-faint">{[t!.node && t!.node !== "local" ? t!.node : "", base(t!.cwd)].filter(Boolean).join(" · ")}</span>
            <span className="truncate ml-auto shrink-0">{ago(t!.createdAt)}</span>
          </div>
        </button>
        <CloseX onClick={() => close(t)} title="Close this terminal" />
      </div>
    );
  };

  return (
    <div ref={strip} className="drag overlay-gap flex items-stretch gap-2 overflow-x-auto px-4 py-1.5 border-b border-line bg-panel min-h-[58px]">
      {!items.length && <div className="text-muted self-center">No sessions running.</div>}
      {ordered.map((g) =>
        headed ? (
          <div key={g.key || "rest"} className="shrink-0 flex flex-col gap-0.5 rounded-lg bg-ground/60 px-1.5 pt-0.5 pb-1.5" data-strip-group={g.ticket ?? g.workspace ?? "other"}>
            <div className="h-4 flex items-center gap-1.5 px-0.5 text-[11px] text-muted min-w-0 max-w-full">
              {g.ticket ? (
                <button type="button" onClick={() => goTicket(g.ticket!)} className="flex items-center gap-1.5 min-w-0 hover:text-ink" title={`${g.ticket}${summaryOf(g.ticket) ? `: ${summaryOf(g.ticket)}` : ""}\nGo to its card on the canvas`}>
                  <span className="font-mono font-medium text-ink shrink-0">{g.ticket}</span>
                  {summaryOf(g.ticket) && <span className="truncate max-w-[220px]">{summaryOf(g.ticket)}</span>}
                </button>
              ) : (
                <span className="truncate">{g.workspace ?? "Other terminals"}</span>
              )}
            </div>
            <div className="flex items-stretch gap-1.5">{g.items.map((it) => card(it, g))}</div>
          </div>
        ) : (
          g.items.map((it) => card(it, g))
        ),
      )}
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

function CloseX({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button onClick={onClick} className="absolute right-0.5 top-0.5 size-5 rounded text-faint hover:text-red hover:bg-red-soft text-[13px] leading-none" title={title} aria-label={title}>
      ×
    </button>
  );
}
