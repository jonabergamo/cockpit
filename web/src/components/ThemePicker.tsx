import { useEffect, useRef, useState } from "react";
import type { Theme } from "@cockpit/shared";
import { themeStore, useTheme, useThemes } from "../lib/theme";

const Swatch = ({ t }: { t: Theme }) => (
  <span className="flex h-4 w-14 shrink-0 overflow-hidden rounded border" style={{ borderColor: t.ui.line, background: t.ui.panel }}>
    {[t.ui.ground, t.ui.accent, t.ui.green, t.ui.amber, t.ui.red].map((c, i) => (
      <span key={i} className="flex-1" style={{ background: c }} />
    ))}
  </span>
);

// Sidebar control: the current theme's name, opening a list where hovering previews and clicking keeps.
export function ThemePicker() {
  const s = useTheme();
  const themes = useThemes();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const close = () => {
    themeStore.preview(undefined);
    setOpen(false);
  };

  const row = (t: Theme) => (
    <button
      key={t.id}
      onMouseEnter={() => themeStore.preview(t.id)}
      onFocus={() => themeStore.preview(t.id)}
      onClick={() => {
        themeStore.choose(t.id);
        setOpen(false);
      }}
      className={`w-full flex items-center gap-2.5 px-3 h-8 text-left text-[13px] hover:bg-ground ${s.choice === t.id ? "text-cobalt font-medium" : ""}`}
    >
      <Swatch t={t} />
      <span className="truncate">{t.name}</span>
    </button>
  );

  const select = (scheme: "light" | "dark", value: string) => (
    <select
      value={value}
      onChange={(e) => themeStore.setAuto(scheme, e.target.value)}
      className="h-7 flex-1 min-w-0 rounded border border-line bg-raised px-1 text-[12px]"
      aria-label={`Theme for ${scheme} mode`}
    >
      {themes
        .filter((t) => t.scheme === scheme)
        .map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
    </select>
  );

  return (
    <div ref={box} className="relative">
      <button onClick={() => (open ? close() : setOpen(true))} className="hover:text-ink max-w-[110px] truncate" title="Theme">
        {/* the chosen theme, not the one being previewed, so the button keeps its width while hovering the list */}
        {s.choice === "auto" ? "Auto" : (themes.find((t) => t.id === s.choice)?.name ?? s.active.name)}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 z-40 w-[260px] max-h-[70vh] overflow-y-auto bg-panel border border-line rounded-lg shadow-xl py-1.5 text-ink" onMouseLeave={() => themeStore.preview(undefined)}>
          <div className="px-3 py-1.5 space-y-1.5">
            <button
              onClick={() => {
                themeStore.choose("auto");
                setOpen(false);
              }}
              onMouseEnter={() => themeStore.preview(undefined)}
              className={`text-[13px] ${s.choice === "auto" ? "text-cobalt font-medium" : "hover:text-cobalt"}`}
            >
              Auto, follow the system
            </button>
            <div className="flex gap-1.5">
              {select("light", s.autoLight)}
              {select("dark", s.autoDark)}
            </div>
          </div>
          <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide text-faint">Dark</div>
          {themes.filter((t) => t.scheme === "dark").map(row)}
          <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide text-faint">Light</div>
          {themes.filter((t) => t.scheme === "light").map(row)}
        </div>
      )}
    </div>
  );
}
