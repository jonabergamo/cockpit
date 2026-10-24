import { Command } from "cmdk";
import type { Ticket } from "@cockpit/shared";
import { useEffect, useRef, useState } from "react";
import { StatusTag } from "./ui";

// A ticket to work on, picked by searching: your sprint's tickets grouped by status in the board's order, then the
// rest of yours, then your epics. A key typed that isn't in the list can be used as it is, and a new ticket can be
// asked for from what was typed.
export function TicketPicker({
  value,
  onChange,
  tickets,
  epics,
  statusOrder,
  keyPattern,
  creating,
  onCreate,
}: {
  value: string;
  onChange: (key: string) => void;
  tickets: Ticket[];
  epics: Ticket[];
  statusOrder: string[];
  keyPattern?: string;
  creating?: boolean;
  // set when the tracker can make tickets: the text typed, to start the new one's summary from
  onCreate?: (summary: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const all = [...tickets, ...epics.filter((e) => !tickets.some((t) => t.key === e.key))];
  const picked = all.find((t) => t.key === value);
  const rank = (s: string) => {
    const i = statusOrder.indexOf(s);
    return i < 0 ? statusOrder.length : i;
  };
  // the sprint's work by status, in the board's order, and what's done last
  const sprint = tickets.filter((t) => t.inSprint);
  const statuses = [...new Set(sprint.map((t) => t.status))].sort((a, b) => rank(a) - rank(b));
  const rest = tickets.filter((t) => !t.inSprint);
  const typedKey = (() => {
    const k = q.trim().toUpperCase();
    try {
      return k && new RegExp(`^(${keyPattern || "[A-Z][A-Z0-9]+-\\d+"})$`).test(k) && !all.some((t) => t.key === k) ? k : "";
    } catch {
      return "";
    }
  })();

  const choose = (key: string) => {
    onChange(key);
    setOpen(false);
    setQ("");
  };
  const row = (t: Ticket) => (
    <Command.Item key={t.key} value={`${t.key} ${t.summary} ${t.status} ${t.type ?? ""}`} onSelect={() => choose(t.key)} className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer data-[selected=true]:bg-raised">
      <span className="font-mono text-[12px] text-muted shrink-0 w-[84px]">{t.key}</span>
      <span className="flex-1 min-w-0 truncate">{t.summary}</span>
      {t.type && <span className="text-[11px] text-faint shrink-0">{t.type}</span>}
      <StatusTag status={t.status} category={t.statusCategory} />
    </Command.Item>
  );
  const group = "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-faint";

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 h-9 rounded-md border border-line bg-raised px-2.5 text-left hover:border-faint focus:outline-none focus:border-cobalt"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {creating ? (
          <span className="flex-1 text-ink">A new ticket, made when you queue it</span>
        ) : picked ? (
          <>
            <span className="font-mono text-[12px] text-muted shrink-0">{picked.key}</span>
            <span className="flex-1 min-w-0 truncate">{picked.summary}</span>
            <StatusTag status={picked.status} category={picked.statusCategory} />
          </>
        ) : value ? (
          <span className="flex-1 font-mono text-[12px]">{value}</span>
        ) : (
          <span className="flex-1 text-faint">No ticket</span>
        )}
        <span className="text-faint text-[11px]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <Command label="Pick a ticket" className="absolute z-20 mt-1 w-full rounded-md border border-line bg-panel shadow-xl overflow-hidden" loop>
          <Command.Input value={q} onValueChange={setQ} autoFocus placeholder="Search your tickets, or type a key" className="w-full h-9 px-3 bg-transparent border-b border-line outline-none" />
          <Command.List className="max-h-[320px] overflow-y-auto p-1">
            <Command.Empty className="px-3 py-4 text-center text-muted">None of your tickets match.</Command.Empty>
            <Command.Item value="__none no ticket" onSelect={() => choose("")} className="px-2 py-1.5 rounded cursor-pointer text-muted data-[selected=true]:bg-raised">
              No ticket
            </Command.Item>
            {typedKey && (
              <Command.Item value={`__key ${typedKey}`} onSelect={() => choose(typedKey)} className="px-2 py-1.5 rounded cursor-pointer data-[selected=true]:bg-raised">
                Use <span className="font-mono">{typedKey}</span> <span className="text-faint">(not one of yours)</span>
              </Command.Item>
            )}
            {onCreate && (
              <Command.Item
                value={`__create new ticket ${q}`}
                onSelect={() => {
                  onCreate(q.trim());
                  setOpen(false);
                  setQ("");
                }}
                className="px-2 py-1.5 rounded cursor-pointer text-cobalt data-[selected=true]:bg-raised"
              >
                + Create a ticket{q.trim() && !typedKey ? `: “${q.trim()}”` : ""}
              </Command.Item>
            )}
            {statuses.map((st) => (
              <Command.Group key={st} heading={`Sprint · ${st}`} className={group}>
                {sprint.filter((t) => t.status === st).map(row)}
              </Command.Group>
            ))}
            {rest.length > 0 && (
              <Command.Group heading="Not in the sprint" className={group}>
                {rest.sort((a, b) => rank(a.status) - rank(b.status)).map(row)}
              </Command.Group>
            )}
            {epics.length > 0 && (
              <Command.Group heading="Epics" className={group}>
                {epics.map(row)}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      )}
    </div>
  );
}
