import { useState } from "react";
import { inputClass, Modal } from "../ui";

export interface FoundCard {
  id: string;
  canvas: string;
  workspace: string;
  kind: string;
  label: string;
  detail?: string;
}

const KIND = { term: "terminal", ticket: "ticket", note: "note", changes: "changes" } as Record<string, string>;

// "/" on the canvas: any card on any workspace by its name, and Enter goes to it
export function CardFinder({ open, cards, onClose, onPick }: { open: boolean; cards: FoundCard[]; onClose: () => void; onPick: (c: FoundCard) => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = cards.filter((c) => words.every((w) => `${c.label} ${c.detail ?? ""} ${c.workspace} ${KIND[c.kind]}`.toLowerCase().includes(w))).slice(0, 30);
  const pick = (c?: FoundCard) => {
    if (!c) return;
    setQ("");
    setAt(0);
    onPick(c);
  };
  return (
    <Modal open={open} onClose={onClose} title="Go to a card">
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setAt((i) => Math.min(i + 1, shown.length - 1));
          else if (e.key === "ArrowUp") setAt((i) => Math.max(i - 1, 0));
          else if (e.key === "Enter") pick(shown[at]);
          else return;
          e.preventDefault();
        }}
        placeholder="A terminal, ticket, note or changes card"
        className={`${inputClass} w-full`}
        aria-label="Find a card"
      />
      <div className="mt-2 max-h-[50vh] overflow-y-auto -mx-1" role="listbox" aria-label="Cards">
        {shown.map((c, i) => (
          <button key={c.id} type="button" role="option" aria-selected={i === at} onMouseEnter={() => setAt(i)} onClick={() => pick(c)} className={`w-full flex items-center gap-2 text-left px-2 py-1.5 rounded text-[13px] ${i === at ? "bg-ground" : ""}`}>
            <span className="text-faint w-16 shrink-0">{KIND[c.kind]}</span>
            <span className="truncate font-medium">{c.label}</span>
            {c.detail && <span className="truncate text-muted">{c.detail}</span>}
            <span className="ml-auto text-faint shrink-0">{c.workspace}</span>
          </button>
        ))}
        {!shown.length && <div className="px-2 py-3 text-[13px] text-muted">No card matches.</div>}
      </div>
    </Modal>
  );
}
