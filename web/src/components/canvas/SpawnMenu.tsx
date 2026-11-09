import { useEffect, useRef } from "react";

// a terminal, or a card that watches the one it came from
// local and codex are a chat with the local model or Codex; their -review kinds review this terminal's turns, and
// -changes review the folder's changes once
export type SpawnKind = "claude" | "review" | "shell" | "changes" | "runs" | "plan" | "setup" | "local" | "local-review" | "local-changes" | "codex" | "codex-review" | "codex-changes";
export interface SpawnOption {
  kind: SpawnKind;
  label: string;
  hint: string;
  disabled?: string;
}

// What to open beside a card: shown where a line was let go over empty canvas, or under a card's + button.
// Esc or a click anywhere else closes it.
export function SpawnMenu({ x, y, from, options, onPick, onClose }: { x: number; y: number; from: string; options: SpawnOption[]; onPick: (k: SpawnKind) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // the click that opened it isn't the one that closes it
    const t = setTimeout(() => window.addEventListener("pointerdown", away, true), 0);
    window.addEventListener("keydown", esc);
    box.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  // kept on screen near the edges
  const left = Math.min(x, window.innerWidth - 280);
  const top = Math.min(y, window.innerHeight - 60 - options.length * 52);
  return (
    <div ref={box} className="fixed z-50 w-64 rounded-lg border border-line bg-raised shadow-xl p-1 text-[13px]" style={{ left, top }} role="menu" aria-label={`Open beside ${from}`}>
      <div className="px-2 pt-1 pb-1.5 text-[12px] text-faint truncate">Beside {from}, in the same folder</div>
      {options.map((o) => (
        <button key={o.kind} type="button" role="menuitem" disabled={!!o.disabled} onClick={() => onPick(o.kind)} className="w-full text-left px-2 py-1.5 rounded hover:bg-ground focus:bg-ground outline-none disabled:opacity-50 disabled:hover:bg-transparent" title={o.disabled}>
          <div className="font-medium">{o.label}</div>
          <div className="text-[12px] text-muted">{o.disabled ?? o.hint}</div>
        </button>
      ))}
    </div>
  );
}
