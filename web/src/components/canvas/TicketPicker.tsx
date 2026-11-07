import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { KitsRes } from "@cockpit/shared";
import { api } from "../../lib/api";
import { useAgentName } from "../../lib/agent";
import { useTickets } from "../../lib/queries";
import { inputClass, Modal, StatusTag } from "../ui";

const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

// whether a ticket picked comes with everything for working on it, remembered on this device
const ALL = "cockpit.ticketSetup";
const readAll = () => {
  try {
    return localStorage.getItem(ALL) === "1";
  } catch {
    return false;
  }
};

// Your open tickets and epics to put on the canvas, or any key typed in. Those already on it are marked. Ticked,
// "everything" sets the ticket up to work on in one go: its worktree, its agent, a reviewer, its changes and runs.
export function TicketPicker({ open, onClose, onPick, placed }: { open: boolean; onClose: () => void; onPick: (key: string, all: boolean, kind?: string) => void; placed: Set<string> }) {
  const tickets = useTickets();
  const agent = useAgentName();
  const [q, setQ] = useState("");
  const [all, setAll] = useState(readAll);
  // the kind whose team it gets: the one the ticket matches, unless you pick another
  const [kind, setKind] = useState("");
  const kits = useQuery({ queryKey: ["kits"], queryFn: () => api.get<KitsRes>("/claude/kits"), enabled: open && all, staleTime: 60_000 }).data;
  const mine = [...(tickets.data?.epics ?? []), ...(tickets.data?.tickets ?? []).filter((t) => !t.finished)];
  const needle = q.trim().toLowerCase();
  const shown = mine.filter((t) => !needle || t.key.toLowerCase().includes(needle) || t.summary.toLowerCase().includes(needle)).slice(0, 40);
  const typed = KEY.test(q.trim()) && !mine.some((t) => t.key === q.trim().toUpperCase()) ? q.trim().toUpperCase() : undefined;
  const pick = (key: string) => {
    setQ("");
    onPick(key, all, kind || undefined);
  };
  return (
    <Modal open={open} onClose={onClose} title="Put a ticket on the canvas">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const first = typed ?? shown[0]?.key;
          if (first) pick(first);
        }}
        placeholder="Search your tickets, or type a key"
        className={`${inputClass} w-full`}
        aria-label="Find a ticket"
      />
      <label className="mt-2 flex items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={all}
          onChange={(e) => {
            setAll(e.target.checked);
            try {
              localStorage.setItem(ALL, e.target.checked ? "1" : "0");
            } catch {}
          }}
        />
        <span>
          Set everything up to work on it
          <span className="block text-[12px] text-faint">The team of its kind of work: its worktree, {agent} planning first, the terminals that work with it, and their cards, laid out and linked</span>
        </span>
      </label>
      {all && !!kits?.kinds.length && (
        <label className="mt-1.5 ml-6 flex items-center gap-2 text-[12px] text-muted">
          Kind of work
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="h-7 rounded border border-line bg-raised px-1.5 text-ink" aria-label="Kind of work">
            <option value="">The one it matches</option>
            {kits.kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} · {k.team.terms.map((m) => m.name).join(", ")}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="mt-2 max-h-[50vh] overflow-y-auto -mx-1" role="listbox" aria-label="Tickets">
        {typed && (
          <button type="button" role="option" aria-selected={false} onClick={() => pick(typed)} className="w-full text-left px-2 py-1.5 rounded hover:bg-ground text-[13px]">
            <span className="font-medium text-cobalt">{typed}</span> <span className="text-muted">· not one of your open tickets</span>
          </button>
        )}
        {shown.map((t) => (
          <button key={t.key} type="button" role="option" aria-selected={false} onClick={() => pick(t.key)} className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded hover:bg-ground text-[13px]">
            <span className="font-medium text-cobalt shrink-0">{t.key}</span>
            <span className="truncate flex-1">{t.summary}</span>
            {"children" in t && <span className="text-faint shrink-0">epic</span>}
            {placed.has(t.key) ? <span className="text-faint shrink-0">on the canvas</span> : <StatusTag status={t.status} category={t.statusCategory} />}
          </button>
        ))}
        {!shown.length && !typed && <div className="px-2 py-3 text-[13px] text-muted">{tickets.isLoading ? "Loading your tickets" : "No ticket matches. Type its full key to add it anyway."}</div>}
      </div>
    </Modal>
  );
}
