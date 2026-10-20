import { useEffect, useMemo, useRef, useState } from "react";
import { useSaveSettings, useSettings } from "../lib/cost";
import { canListFonts, codeStack, defaultFonts, type Fonts, installed, listSystemFonts, type SystemFont, uiStack } from "../lib/fonts";
import { Button, ErrorNote, inputClass } from "./ui";

// A name box with the device's fonts below it, each shown in itself. Typing a name works too,
// for browsers that can't list fonts or a font the list doesn't have.
function FontPicker({ label, value, fonts, code, onChange, onLoad }: { label: string; value: string; fonts?: SystemFont[]; code?: boolean; onChange: (name: string) => void; onLoad: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [onlyMono, setOnlyMono] = useState(!!code);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);

  const q = draft.trim().toLowerCase();
  const shown = useMemo(() => {
    const list = (fonts ?? []).filter((f) => (!onlyMono || f.mono) && (!q || q === value.toLowerCase() || f.family.toLowerCase().includes(q)));
    return list.slice(0, 300);
  }, [fonts, onlyMono, q, value]);
  const missing = !!value && !installed(value);
  const commit = (name: string) => {
    setOpen(false);
    if (name.trim() !== value) onChange(name.trim());
  };

  return (
    <div className="space-y-1.5" ref={root}>
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted w-24 shrink-0">{label}</span>
        <div className="relative flex-1 min-w-0">
          <input
            value={draft}
            placeholder={code ? "JetBrains Mono (built in)" : "Schibsted Grotesk (built in)"}
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(shown.length && q && !shown.some((f) => f.family.toLowerCase() === q) ? shown[0].family : draft);
              if (e.key === "Escape") {
                setDraft(value);
                setOpen(false);
              }
            }}
            onBlur={(e) => !root.current?.contains(e.relatedTarget as Node) && commit(draft)}
            style={{ fontFamily: draft ? (code ? codeStack({ ...defaultFonts, code: draft }) : uiStack({ ...defaultFonts, ui: draft })) : undefined }}
            className={`${inputClass} w-full`}
            autoComplete="off"
            spellCheck={false}
          />
          {open && !!fonts?.length && (
            <div className="absolute z-20 left-0 right-0 top-9 bg-raised border border-line rounded-md shadow-lg overflow-hidden">
              {code && (
                <label className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-muted border-b border-line">
                  <input type="checkbox" checked={onlyMono} onChange={(e) => setOnlyMono(e.target.checked)} />
                  Monospaced only
                </label>
              )}
              <div className="max-h-72 overflow-y-auto py-1">
                {shown.map((f) => (
                  <button
                    key={f.family}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setDraft(f.family);
                      commit(f.family);
                    }}
                    className={`w-full text-left px-2.5 py-1 hover:bg-ground flex items-baseline gap-3 ${f.family === value ? "text-cobalt" : "text-ink"}`}
                  >
                    <span className="truncate text-[14px]" style={{ fontFamily: `"${f.family}", ${code ? "monospace" : "sans-serif"}` }}>
                      {f.family}
                    </span>
                    {!code && f.mono && <span className="text-[11px] text-faint shrink-0">mono</span>}
                  </button>
                ))}
                {!shown.length && <div className="px-2.5 py-2 text-[13px] text-faint">No font on this device matches. Enter keeps the name as typed.</div>}
              </div>
            </div>
          )}
        </div>
        {!fonts && canListFonts() && (
          <Button size="sm" onClick={onLoad} title="Your browser asks once before it shows a page the installed fonts">
            List my fonts
          </Button>
        )}
        {value && (
          <Button size="sm" variant="ghost" onClick={() => onChange("")}>
            Reset
          </Button>
        )}
      </div>
      {missing && <p className="text-[12px] text-amber ml-[104px]">Not installed on this device, so it shows the built-in font here.</p>}
    </div>
  );
}

export function FontSection() {
  const q = useSettings();
  const save = useSaveSettings();
  const [err, setErr] = useState<unknown>();
  const [fonts, setFonts] = useState<SystemFont[]>();
  const f = q.data?.settings.fonts ?? defaultFonts;

  const put = (patch: Partial<Fonts>) => {
    setErr(undefined);
    save({ fonts: { ...f, ...patch } }).catch(setErr);
  };
  const load = async () => {
    setErr(undefined);
    try {
      const list = await listSystemFonts();
      if (!list.length) throw new Error("The browser didn't give cockpit any fonts. Check the site's font permission.");
      setFonts(list);
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div>
        <h2 className="font-semibold">Fonts</h2>
        <p className="text-[13px] text-muted mt-0.5">
          Any font installed on your device. The code font is used by terminals and editors.{" "}
          {canListFonts() ? "List my fonts shows what's installed." : "This browser can't list installed fonts, so type the font's name."} A device that doesn't have the font shows the built-in one.
        </p>
      </div>
      <FontPicker label="Interface" value={f.ui} fonts={fonts} onChange={(ui) => put({ ui })} onLoad={load} />
      <FontPicker label="Code" value={f.code} fonts={fonts} code onChange={(code) => put({ code })} onLoad={load} />
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted w-24 shrink-0">Code size</span>
        <Button size="sm" disabled={f.codeSize <= 9} onClick={() => put({ codeSize: f.codeSize - 1 })}>
          −
        </Button>
        <span className="w-10 text-center tabular-nums text-[13px]">{f.codeSize}px</span>
        <Button size="sm" disabled={f.codeSize >= 24} onClick={() => put({ codeSize: f.codeSize + 1 })}>
          +
        </Button>
      </div>
      <pre className="bg-ground rounded-md px-3 py-2 text-ink overflow-x-auto" style={{ fontFamily: codeStack(f), fontSize: f.codeSize }}>
        {"const ok = sessions.filter((s) => s.state !== \"idle\"); // 0O 1lI {} => != ->"}
      </pre>
      <ErrorNote error={err} />
    </section>
  );
}
