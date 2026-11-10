import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { PanelPart, RelayLogEntry } from "@cockpit/shared";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";

const OUTCOME: Record<RelayLogEntry["outcome"], { word: string; look: string }> = {
  pending: { word: "sending", look: "text-cobalt" },
  delivered: { word: "delivered", look: "text-green" },
  held: { word: "held", look: "text-amber" },
  failed: { word: "not passed on", look: "text-red" },
  "stopped-ack": { word: "stopped at an acknowledgement", look: "text-muted" },
  limit: { word: "limit reached", look: "text-amber" },
};
const KIND: Record<RelayLogEntry["kind"], string> = {
  forward: "turn",
  back: "review back",
  handoff: "handed over",
  held: "held back",
  "skipped-ack": "only acknowledged",
  "skipped-limit": "past the limit",
  panel: "panel review",
};
const PART: Record<PanelPart["outcome"], string> = { answered: "", acknowledged: "only acknowledged", silent: "didn't answer" };

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The message read as it was sent: a diff block in it monospaced, the rest as prose
function Message({ text }: { text: string }) {
  // a fence is three backticks or more, longer when what it holds has some
  const parts: { code: boolean; text: string }[] = [];
  let at = 0;
  for (const m of text.matchAll(/^(`{3,})[^\n]*\n([\s\S]*?)(?:\n\1[ \t]*$|$(?![\s\S]))/gm)) {
    parts.push({ code: false, text: text.slice(at, m.index) }, { code: true, text: m[2] });
    at = m.index + m[0].length;
  }
  parts.push({ code: false, text: text.slice(at) });
  return (
    <div className="mt-1.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink">
      {parts.map((p, i) =>
        p.code ? (
          <pre key={i} className="my-1 p-2 rounded bg-ground border border-line font-mono text-[11px] overflow-x-auto whitespace-pre">
            {p.text}
          </pre>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </div>
  );
}

function Entry({ e, name, terms, by }: { e: RelayLogEntry; name: (card: string) => string; terms: { id: string; name: string }[]; by: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [each, setEach] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const o = OUTCOME[e.outcome];
  const again = (to?: string) => {
    setBusy(true);
    setErr(undefined);
    setPicking(false);
    api
      .post(`/canvas/log/${e.id}/replay`, { to, by })
      .then(() => qc.invalidateQueries({ queryKey: ["canvas-log", e.edge] }))
      .catch((x) => setErr(why(x)))
      .finally(() => setBusy(false));
  };
  const first = e.text.split("\n").find((l) => l.trim() && !/^From .*:$/.test(l.trim())) ?? e.text;
  const btn = "h-6 px-2 rounded-full border border-line bg-ground hover:border-cobalt hover:text-cobalt disabled:opacity-50";
  return (
    <li className="px-3 py-2 border-b border-line/60 last:border-0" data-log-entry={e.id} data-log-outcome={e.outcome}>
      <div className="flex items-center gap-1.5 text-[12px]">
        <span className="font-medium truncate">
          {name(e.from)} → {name(e.to)}
        </span>
        <span className="ml-auto shrink-0 text-faint" title={new Date(e.at).toLocaleString()}>
          {ago(e.at)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
        <span>{KIND[e.kind]}</span>
        {e.replay ? <span className="text-cobalt">sent again</span> : e.limit && e.kind !== "handoff" ? <span className="tabular-nums">hop {e.hop}/{e.limit}</span> : null}
        <span className={o.look} title={e.note}>
          {o.word}
        </span>
      </div>
      {e.note && e.outcome !== "delivered" && <div className={`text-[11px] leading-snug ${e.outcome === "failed" ? "text-red" : "text-muted"}`}>{e.note}</div>}
      {e.text && (open ? <Message text={e.text} /> : <div className="mt-1 text-[12px] text-muted line-clamp-2">{first}</div>)}
      {e.parts && each && (
        <ol className="mt-1.5 space-y-1.5 border-l-2 border-line pl-2" data-panel-parts={e.id}>
          {e.parts.map((p, i) => (
            <li key={i}>
              <div className="text-[11px] text-faint">
                <span className="font-medium text-muted">{p.name}</span> {PART[p.outcome]}
              </div>
              {p.text && <Message text={p.text} />}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        {e.text && (
          <button type="button" onClick={() => setOpen(!open)} className="h-6 px-1.5 rounded text-muted hover:text-ink hover:bg-ground">
            {open ? "Collapse" : "Read it all"}
          </button>
        )}
        {e.parts && (
          <button type="button" onClick={() => setEach(!each)} className="h-6 px-1.5 rounded text-muted hover:text-ink hover:bg-ground" title="What each reviewer of the panel said, before it was merged">
            {each ? "Hide each review" : `Each review (${e.parts.filter((p) => p.outcome !== "silent").length} of ${e.parts.length})`}
          </button>
        )}
        {e.text && (
          <>
            <button type="button" disabled={busy} onClick={() => again()} className={btn} title={`Send this message to ${name(e.to)} again. It doesn't count against the line's hops`}>
              {busy ? "Sending" : "Send again"}
            </button>
            <button type="button" disabled={busy || !terms.length} onClick={() => setPicking(!picking)} className={btn} title="Send this message to another terminal on this workspace">
              Send to…
            </button>
          </>
        )}
      </div>
      {picking && (
        <div className="mt-1 flex flex-col rounded border border-line bg-ground max-h-40 overflow-y-auto" role="menu">
          {terms.map((t) => (
            <button key={t.id} type="button" role="menuitem" onClick={() => again(t.id)} className="text-left px-2 h-7 text-[12px] truncate hover:bg-raised hover:text-cobalt">
              {t.name}
            </button>
          ))}
        </div>
      )}
      {err && <div className="mt-1 text-[11px] text-red">⚠ {err}</div>}
    </li>
  );
}

// Everything a line between two terminals carried, or held back, in order: who to whom, which hop, how it went, and
// the message itself to read or send again
export function LineHistory({ edge, stamp, names, terms, by, onClose }: { edge: string; stamp: string; names: [string, string]; terms: { id: string; name: string }[]; by: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["canvas-log", edge, stamp], queryFn: () => api.get<RelayLogEntry[]>(`/canvas/edges/${edge}/log`) });
  const byCard = new Map(terms.map((t) => [t.id, t.name]));
  const name = (card: string) => byCard.get(card) ?? "a terminal that's gone";
  const items = q.data ?? [];
  return (
    <div className="absolute top-3 right-3 bottom-3 z-10 w-[440px] max-w-[calc(100%-24px)] flex flex-col rounded-lg border border-line bg-raised shadow-xl text-[13px]" role="region" aria-label="Line history" data-line-history={edge}>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line shrink-0">
        <span className="font-medium truncate">
          {names[0]} ⇄ {names[1]}
        </span>
        <button type="button" onClick={onClose} className="ml-auto h-6 px-2 rounded text-muted hover:text-ink hover:bg-ground">
          Close
        </button>
      </div>
      <div className="overflow-y-auto">
        {q.isLoading ? (
          <div className="px-3 py-2 text-muted">Reading the line's history</div>
        ) : q.error ? (
          <div className="px-3 py-2 text-red">Couldn't read it: {why(q.error)}</div>
        ) : !items.length ? (
          <div className="px-3 py-2 text-muted">Nothing has gone along this line yet.</div>
        ) : (
          <ol>
            {items.map((e) => (
              <Entry key={e.id} e={e} name={name} terms={terms} by={by} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
