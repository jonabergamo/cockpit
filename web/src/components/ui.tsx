import { useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Tone = "plain" | "cobalt" | "amber" | "green" | "red" | "faint";

const tones: Record<Tone, string> = {
  plain: "bg-ground text-ink",
  faint: "bg-ground text-muted",
  cobalt: "bg-cobalt-soft text-cobalt",
  amber: "bg-amber-soft text-amber",
  green: "bg-green-soft text-green",
  red: "bg-red-soft text-red",
};

export function Tag({ tone = "plain", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded px-1.5 py-px text-[12px] font-medium whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function statusTone(status?: string, category?: string): Tone {
  const s = (status ?? "").toLowerCase();
  if (/block|hold/.test(s)) return "red";
  if (/done|pending deploy|released|closed/.test(s)) return "green";
  if (/review|qa|uat|test/.test(s)) return "amber";
  if (/progress/.test(s) || category === "indeterminate") return "cobalt";
  return "faint";
}

export const StatusTag = ({ status, category }: { status: string; category?: string }) => <Tag tone={statusTone(status, category)}>{status}</Tag>;

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "default"; size?: "sm" | "md" };

export function Button({ variant = "default", size = "md", className = "", ...rest }: BtnProps) {
  const v = {
    default: "bg-raised border border-line hover:border-faint text-ink",
    primary: "bg-cobalt text-on-accent hover:brightness-110 border border-transparent",
    ghost: "text-muted hover:text-ink hover:bg-ground border border-transparent",
    danger: "bg-raised border border-line text-red hover:bg-red-soft",
  }[variant];
  const s = size === "sm" ? "h-7 px-2 text-[13px]" : "h-8 px-3";
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none ${v} ${s} ${className}`}
    />
  );
}

export function Panel({
  title,
  actions,
  children,
  className = "",
  bodyClass = "",
  busy,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  // a wave over it while what it shows is about to change
  busy?: boolean;
}) {
  return (
    <section className={`bg-panel border border-line rounded-lg flex flex-col min-h-0 ${busy ? "wave" : ""} ${className}`}>
      {(title || actions) && (
        <header className="flex items-center gap-2 px-3 h-10 border-b border-line shrink-0">
          <h2 className="font-semibold text-[14px] flex-1 truncate">{title}</h2>
          {actions}
        </header>
      )}
      <div className={`min-h-0 ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, children, sub }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 mb-4">
      <div className="flex-1 min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight leading-tight">{title}</h1>
        {sub && <p className="text-muted mt-0.5">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="text-muted px-4 py-8 text-center">{children}</div>;

export const Spinner = ({ className = "" }: { className?: string }) => (
  <span className={`inline-block size-3.5 rounded-full border-2 border-line border-t-cobalt animate-spin ${className}`} />
);

export const Skeleton = ({ className = "" }: { className?: string }) => <div className={`sk ${className}`} />;

// a few widths so the placeholder rows don't line up like a grid
const widths = ["w-[62%]", "w-[48%]", "w-[71%]", "w-[55%]", "w-[66%]", "w-[40%]"];

// placeholders shaped like what's coming: rows of a list, cards on a board, or short lines in a narrow column
export function Loading({ what, rows = 3, shape = "rows" }: { what?: string; rows?: number; shape?: "rows" | "cards" | "lines" }) {
  const n = Array.from({ length: rows }, (_, i) => i);
  return (
    <div role="status" aria-busy="true" aria-label={what ?? "Loading"} className={shape === "lines" ? "px-3 py-2" : "px-4 py-4"}>
      {what && <div className="text-[12px] text-faint mb-3">{what}</div>}
      {shape === "cards" ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {n.map((i) => (
            <div key={i} className="bg-panel border border-line rounded-lg p-4 space-y-2.5">
              <Skeleton className={`h-3.5 ${widths[i % widths.length]}`} />
              <Skeleton className="h-2.5 w-[35%]" />
              <div className="flex gap-1.5 pt-1">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-12 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : shape === "lines" ? (
        <div className="space-y-2.5">
          {n.map((i) => (
            <Skeleton key={i} className={`h-2.5 ${widths[i % widths.length]}`} />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {n.map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className={`h-3 ${widths[i % widths.length]}`} />
              <Skeleton className={`h-2.5 ${widths[(i + 3) % widths.length]} opacity-70`} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="text-red bg-red-soft rounded-md px-3 py-2 text-[13px]">{error instanceof Error ? error.message : String(error)}</div>;
}

export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="font-mono text-[11px] border border-line rounded px-1 py-px text-muted bg-raised">{children}</kbd>
);

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex bg-ground rounded-md p-0.5 gap-0.5">
      {items.map((it) => (
        <button
          key={it.value}
          onClick={() => onChange(it.value)}
          className={`px-2.5 h-7 rounded text-[13px] font-medium ${value === it.value ? "bg-raised text-ink shadow-[0_0_0_1px_var(--line)]" : "text-muted hover:text-ink"}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Drawer({ open, onClose, children, width = "min(720px, 100vw)" }: { open: boolean; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div style={{ width }} className="relative h-full bg-panel border-l border-line overflow-y-auto shadow-xl">
        {children}
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`fixed inset-0 z-50 flex items-start justify-center px-4 ${wide ? "pt-[6vh]" : "pt-[12vh]"}`}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className={`relative w-full ${wide ? "max-w-3xl" : "max-w-lg"} bg-panel border border-line rounded-lg shadow-xl`}>
        <h2 className="font-semibold px-4 pt-3 pb-2">{title}</h2>
        <div className="px-4 pb-4">{children}</div>
      </div>
    </div>
  );
}

export const Markdown = ({ children }: { children: string }) => (
  <div className="prose-cockpit">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
  </div>
);

export const inputClass = "h-8 rounded-md border border-line bg-raised px-2.5 text-ink placeholder:text-faint focus:outline-none focus:border-cobalt";

// navigator.clipboard only exists on https or localhost, so over plain http to the dev box fall back to the old copy command
export function copy(text: string) {
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  legacyCopy(text);
  return Promise.resolve();
}

function legacyCopy(text: string) {
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    ta.remove();
    prev?.focus();
  }
}
