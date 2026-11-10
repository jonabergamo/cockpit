import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { useSaveSettings, useSettings } from "../lib/cost";

export interface ReplyChip {
  text: string;
  count: number;
  pinned?: boolean;
}

const key = (s: string) => s.trim().toLowerCase();

// The short replies you type most, under a reply box: a tap puts one in the box, and a tap on the same one again
// (or Enter) sends it. Shown by how often you use them at once, then by how well they fit what the session last
// said, when there's a local model to ask. Edit pins one first or hides it for good.
export function ReplyChips({ text, last, onPick, onSend, onFail }: { text: string; last?: string; onPick: (t: string) => void; onSend: () => void; onFail: (e: unknown) => void }) {
  const settings = useSettings();
  const save = useSaveSettings();
  const [editing, setEditing] = useState(false);
  const s = settings.data?.settings.replies;
  // pins and hides are applied by the server, so a change to them asks again
  const q = useQuery({ queryKey: ["replies", s], queryFn: () => api.get<{ on: boolean; chips: ReplyChip[] }>("/replies/frequent"), staleTime: 5 * 60_000, placeholderData: (prev) => prev });
  const chips = q.data?.chips ?? [];
  const loose = chips.filter((c) => !c.pinned).map((c) => c.text);
  const rank = useQuery({
    queryKey: ["replies-rank", last, loose],
    queryFn: () => api.post<{ order: string[] | null }>("/replies/rank", { last, texts: loose }),
    enabled: !!last?.trim() && loose.length > 1 && !editing,
    staleTime: Infinity,
    retry: false,
  });
  const order = rank.data?.order;
  const shown = order ? [...chips.filter((c) => c.pinned), ...order.map((t) => chips.find((c) => c.text === t)).filter((c): c is ReplyChip => !!c)] : chips;

  const change = async (fn: (r: { pinned: string[]; hidden: string[] }) => { pinned: string[]; hidden: string[] }) => {
    if (!s) return;
    try {
      await save({ replies: { ...s, ...fn(s) } });
    } catch (e) {
      onFail(e);
    }
  };
  const pin = (c: ReplyChip) => change((r) => ({ ...r, pinned: c.pinned ? r.pinned.filter((p) => key(p) !== key(c.text)) : [...r.pinned, c.text] }));
  const hide = (c: ReplyChip) => change((r) => ({ pinned: r.pinned.filter((p) => key(p) !== key(c.text)), hidden: [...r.hidden, c.text] }));

  if (!q.data?.on || !shown.length) return q.error ? <div className="text-[12px] text-red">Couldn't load your usual replies: {(q.error as Error).message}</div> : null;
  return (
    <div className="flex flex-wrap items-center gap-1" data-reply-chips>
      {shown.map((c) => (
        <span key={c.text} className={`inline-flex items-center rounded-full border text-[12px] max-w-full ${key(text) === key(c.text) ? "border-cobalt bg-cobalt-soft text-cobalt" : "border-line bg-raised hover:border-faint"}`}>
          <button
            type="button"
            onClick={() => (key(text) === key(c.text) ? onSend() : onPick(c.text))}
            className="h-6 px-2 truncate max-w-[220px]"
            title={key(text) === key(c.text) ? "Tap again to send" : c.count ? `You've sent this ${c.count} times in the last 30 days` : "Pinned"}
          >
            {c.pinned && <span className="mr-1 opacity-60">★</span>}
            {c.text}
          </button>
          {editing && (
            <>
              <button type="button" onClick={() => pin(c)} className="h-6 px-1 text-muted hover:text-ink" title={c.pinned ? "Unpin" : "Pin, so it always shows first"}>
                {c.pinned ? "unpin" : "pin"}
              </button>
              <button type="button" onClick={() => hide(c)} className="h-6 pl-1 pr-2 text-muted hover:text-red" title="Never show this one (Settings → Automation brings it back)">
                ×
              </button>
            </>
          )}
        </span>
      ))}
      <button type="button" onClick={() => setEditing((v) => !v)} className="h-6 px-1.5 text-[12px] text-faint hover:text-ink">
        {editing ? "Done" : "Edit"}
      </button>
    </div>
  );
}
