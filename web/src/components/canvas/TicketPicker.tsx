import { useState } from "react";
import { useTickets } from "../../lib/queries";
import { inputClass, Modal, StatusTag } from "../ui";

const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

// Your open tickets and epics to put on the canvas, or any key typed in. Those already on it are marked.
export function TicketPicker({ open, onClose, onPick, placed }: { open: boolean; onClose: () => void; onPick: (key: string) => void; placed: Set<string> }) {
  const tickets = useTickets();
  const [q, setQ] = useState("");
  const all = [...(tickets.data?.epics ?? []), ...(tickets.data?.tickets ?? []).filter((t) => !t.finished)];
  const needle = q.trim().toLowerCase();
  const shown = all.filter((t) => !needle || t.key.toLowerCase().includes(needle) || t.summary.toLowerCase().includes(needle)).slice(0, 40);
  const typed = KEY.test(q.trim()) && !all.some((t) => t.key === q.trim().toUpperCase()) ? q.trim().toUpperCase() : undefined;
  const pick = (key: string) => {
    setQ("");
    onPick(key);
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
