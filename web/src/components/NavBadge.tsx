import type { Badge } from "@cockpit/shared";

// One sidebar entry's badge: a pulsing dot while something runs, an amber or red number when something needs you,
// a grey number for plain totals. The dot sits beside a number when both apply.
export function NavBadge({ badge }: { badge?: Badge }) {
  if (!badge) return null;
  const { live, attention, failed, count } = badge;
  const pill = failed ? { n: failed, tone: "bg-red-soft text-red" } : attention ? { n: attention, tone: "bg-amber-soft text-amber" } : undefined;
  return (
    <span className="flex items-center gap-1 shrink-0" role="img" aria-label={badge.title}>
      {!!live && (
        <span className="flex items-center gap-0.5 text-[11px] text-cobalt tabular-nums">
          <span className="size-1.5 rounded-full bg-cobalt animate-pulse motion-reduce:animate-none" />
          {!pill && live > 1 && live}
        </span>
      )}
      {pill ? (
        <span className={`min-w-[18px] h-[18px] px-1 grid place-items-center rounded-full text-[11px] font-medium tabular-nums ${pill.tone}`}>{pill.n}</span>
      ) : (
        !live && !!count && <span className="text-[11px] text-faint tabular-nums">{count}</span>
      )}
    </span>
  );
}
