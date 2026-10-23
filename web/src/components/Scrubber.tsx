import type { Entry } from "@cockpit/shared";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { time } from "../lib/format";

type Kind = "prompt" | "edit" | "error" | "tool" | "reply";

interface Mark {
  i: number;
  kind: Kind;
  ts: string;
  label: string;
}

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const LOOK: Record<Kind, { y: number; h: number; cls: string }> = {
  prompt: { y: 0, h: 28, cls: "fill-cobalt" },
  error: { y: 8, h: 20, cls: "fill-red" },
  edit: { y: 12, h: 16, cls: "fill-green" },
  tool: { y: 18, h: 10, cls: "fill-faint" },
  reply: { y: 22, h: 6, cls: "fill-line" },
};

function marksOf(entries: Entry[]): Mark[] {
  const failed = new Set(entries.filter((e) => e.kind === "tool_result" && e.isError).map((e) => (e as Extract<Entry, { kind: "tool_result" }>).toolUseId));
  const out: Mark[] = [];
  entries.forEach((e, i) => {
    if (e.kind === "user") out.push({ i, kind: "prompt", ts: e.ts, label: e.text.split("\n")[0].slice(0, 120) });
    else if (e.kind === "assistant") out.push({ i, kind: "reply", ts: e.ts, label: e.text.split("\n")[0].slice(0, 120) });
    else if (e.kind === "tool") {
      const input = (e.input ?? {}) as Record<string, unknown>;
      const what = String(input.description ?? input.file_path ?? input.command ?? input.pattern ?? "").split("\n")[0].slice(0, 100);
      out.push({ i, kind: failed.has(e.toolUseId) ? "error" : EDITS.has(e.name) ? "edit" : "tool", ts: e.ts, label: `${e.name}${what ? `: ${what}` : ""}` });
    }
  });
  // the tallest marks go last so they're drawn on top
  const order: Kind[] = ["reply", "tool", "edit", "error", "prompt"];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

// A strip of the whole session: your prompts, edits, errors and tool calls in order. The window shows what's on
// screen; hover for what happened, click or drag to go there.
export function Scrubber({ entries, scroller }: { entries: Entry[]; scroller: RefObject<HTMLDivElement | null> }) {
  const marks = useMemo(() => marksOf(entries), [entries]);
  const bar = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<[number, number]>([0, 1]);
  const [hover, setHover] = useState<{ x: number; mark?: Mark }>();
  const n = Math.max(1, entries.length - 1);

  // which entries are on screen, as a share of the whole
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = el.getBoundingClientRect().top;
      const items = el.querySelectorAll<HTMLElement>("[data-i]");
      let first: number | undefined, last: number | undefined;
      for (const it of items) {
        const r = it.getBoundingClientRect();
        if (r.bottom < top) continue;
        if (r.top > top + el.clientHeight) break;
        const i = Number(it.dataset.i);
        first ??= i;
        last = i;
      }
      if (first !== undefined && last !== undefined) setView([first / n, last / n]);
    };
    const onScroll = () => (frame ||= requestAnimationFrame(update));
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller, n, entries.length]);

  const at = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const nearest = (f: number) => {
    let best: Mark | undefined;
    for (const m of marks) if (!best || Math.abs(m.i / n - f) < Math.abs(best.i / n - f) || (Math.abs(m.i / n - f) === Math.abs(best.i / n - f) && m.kind === "prompt")) best = m;
    return best;
  };
  const go = (f: number) => {
    const el = scroller.current;
    if (!el) return;
    const want = Math.round(f * n);
    // the closest rendered entry at or before it; results and hidden entries have no element
    const items = [...el.querySelectorAll<HTMLElement>("[data-i]")];
    const target = items.reduce<HTMLElement | undefined>((b, it) => (Number(it.dataset.i) <= want ? it : b), undefined) ?? items[0];
    if (target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
  };

  if (marks.length < 2) return null;
  const first = entries.find((e) => e.ts)?.ts;
  const last = [...entries].reverse().find((e) => e.ts)?.ts;
  const prompts = marks.filter((m) => m.kind === "prompt").length;
  const edits = marks.filter((m) => m.kind === "edit").length;
  const errors = marks.filter((m) => m.kind === "error").length;

  return (
    <div className="mb-3 select-none">
      <div className="flex items-center gap-3 text-[11px] text-faint mb-1">
        <span>{first && time(first)}</span>
        <span className="flex-1 flex justify-center gap-3">
          <span><i className="inline-block size-2 rounded-sm bg-cobalt mr-1" />{prompts} {prompts === 1 ? "prompt" : "prompts"}</span>
          <span><i className="inline-block size-2 rounded-sm bg-green mr-1" />{edits} {edits === 1 ? "edit" : "edits"}</span>
          {errors > 0 && <span><i className="inline-block size-2 rounded-sm bg-red mr-1" />{errors} failed</span>}
        </span>
        <span>{last && time(last)}</span>
      </div>
      <div
        ref={bar}
        className="relative h-8 rounded-md bg-ground cursor-pointer touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          go(at(e.clientX));
        }}
        onPointerMove={(e) => {
          const f = at(e.clientX);
          setHover({ x: f, mark: nearest(f) });
          if (e.buttons === 1) go(f);
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 1000 28" preserveAspectRatio="none" aria-hidden>
          {marks.map((m) => (
            <rect key={`${m.kind}${m.i}`} x={(m.i / n) * 996} y={LOOK[m.kind].y} width={4} height={LOOK[m.kind].h} className={LOOK[m.kind].cls} />
          ))}
        </svg>
        <div className="absolute -inset-y-1 rounded border-2 border-ink/70 bg-ink/10 pointer-events-none" title="On screen" style={{ left: `calc(${view[0] * 100}% - 3px)`, width: `max(10px, calc(${(view[1] - view[0]) * 100}% + 6px))` }} />
        {hover?.mark && (
          <div className="absolute bottom-full mb-1.5 z-10 max-w-[360px] rounded-md border border-line bg-raised px-2 py-1 text-[12px] shadow-lg pointer-events-none" style={{ left: `${hover.x * 100}%`, transform: `translateX(-${hover.x * 100}%)` }}>
            <span className="text-faint">{time(hover.mark.ts)} · </span>
            <span className={hover.mark.kind === "error" ? "text-red" : hover.mark.kind === "prompt" ? "text-cobalt" : ""}>{hover.mark.kind === "prompt" ? `You: ${hover.mark.label}` : hover.mark.label}</span>
          </div>
        )}
      </div>
    </div>
  );
}
