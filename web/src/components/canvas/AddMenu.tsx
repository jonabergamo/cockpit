import { useEffect, useRef, useState } from "react";
import { Button } from "../ui";

export interface AddOption {
  label: string;
  hint: string;
  onPick: () => void;
}

// The toolbar's one button for a new card on the workspace, with what it can be in a menu under it.
// Esc or a click anywhere else closes it.
export function AddMenu({ options }: { options: AddOption[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    box.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  // where the menu goes: under the button, kept on screen. The toolbar scrolls sideways, so it's fixed, not inside it
  const at = open ? box.current?.getBoundingClientRect() : undefined;
  return (
    <div ref={box} className="shrink-0">
      <Button size="sm" variant={open ? "default" : "ghost"} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="A new card on this workspace">
        + Add <span className="text-faint">▾</span>
      </Button>
      {open && at && (
        <div className="fixed z-50 w-72 rounded-lg border border-line bg-raised shadow-xl p-1 text-[13px]" style={{ left: Math.max(8, Math.min(at.left, window.innerWidth - 296)), top: at.bottom + 4 }} role="menu" aria-label="Add to this workspace">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                o.onPick();
              }}
              onKeyDown={(e) => {
                if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                e.preventDefault();
                const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
                const i = items.indexOf(e.currentTarget);
                items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
              }}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-ground focus:bg-ground outline-none"
            >
              <div className="font-medium">{o.label}</div>
              <div className="text-[12px] text-muted">{o.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
