import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AskInfo, Session } from "@cockpit/shared";
import { api } from "../lib/api";
import { useOpenSession } from "../lib/openSession";
import { Button, ErrorNote, inputClass } from "./ui";

const summary = (p: AskInfo["pending"]) => {
  if (!p) return "";
  const i = (p.input ?? {}) as Record<string, unknown>;
  const what = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.description;
  return `${p.name}${typeof what === "string" ? `: ${what.length > 140 ? `${what.slice(0, 140)}…` : what}` : ""}`;
};

// Answers a waiting session without opening its terminal: the menu it's showing becomes buttons, and a reply
// goes straight into its input. Sessions outside cockpit's terminals get resumed in one instead.
export function ReplyPanel({ session, compact = false, onSent }: { session: Pick<Session, "id" | "status" | "pid" | "term">; compact?: boolean; onSent?: () => void }) {
  const qc = useQueryClient();
  const openSession = useOpenSession();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [showScreen, setShowScreen] = useState(!compact);
  const live = session.status !== "ended";
  const q = useQuery({
    queryKey: ["ask", session.id],
    queryFn: () => api.get<AskInfo>(`/sessions/${session.id}/ask`),
    enabled: live,
    refetchInterval: session.status === "waiting" ? 2500 : 6000,
  });
  const ask = q.data;
  const refresh = () => setTimeout(() => qc.invalidateQueries({ queryKey: ["ask", session.id] }), 400);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
      refresh();
      onSent?.();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const keys = (k: string[]) => run(async () => void (await api.post(`/sessions/${session.id}/keys`, { keys: k })));
  const reply = () =>
    run(async () => {
      const msg = text.trim();
      if (!msg) return;
      const { sent } = ask?.reachable ? await api.post<{ sent: boolean }>(`/sessions/${session.id}/send`, { text: msg }) : { sent: false };
      setText("");
      if (!sent) await openSession(session, msg);
    });

  if (!live) return null;
  const lines = (ask?.screen ?? "").split("\n").slice(compact ? -10 : -24).join("\n");

  return (
    <div className="space-y-2 text-[13px]">
      {ask?.options.length ? (
        <div className="space-y-1.5">
          {ask.question && <div className="font-medium">{ask.question}</div>}
          <div className="flex flex-wrap gap-1.5">
            {ask.options.map((o) => (
              <Button key={o.key} size="sm" variant={o.key === "1" ? "primary" : "default"} disabled={busy} onClick={() => keys([o.key])} title={o.label}>
                <span className="font-mono opacity-70">{o.key}</span>
                <span className="max-w-[260px] truncate">{o.label}</span>
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => keys(["Escape"])} title="Esc: cancel and tell Claude what to do instead">
              Esc
            </Button>
          </div>
        </div>
      ) : ask?.pending && session.status !== "busy" ? (
        <div className="text-muted">
          Waiting on <span className="font-mono text-ink">{summary(ask.pending)}</span>
        </div>
      ) : null}

      {ask?.reachable && lines.trim() ? (
        <div>
          <button className="text-[12px] text-faint hover:text-ink" onClick={() => setShowScreen((v) => !v)}>
            {showScreen ? "Hide its screen" : "Show its screen"}
          </button>
          {showScreen && <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-ground px-3 py-2 font-mono text-[11.5px] leading-[1.45] text-ink/90 whitespace-pre-wrap">{lines}</pre>}
        </div>
      ) : ask?.last ? (
        <div className={`rounded-md bg-ground px-3 py-2 text-ink/90 whitespace-pre-wrap ${compact ? "line-clamp-4" : "max-h-60 overflow-auto"}`}>{ask.last}</div>
      ) : null}

      {ask?.draft && <div className="text-[12px] text-amber">There's unsent text in its input: “{ask.draft.slice(0, 80)}”. A reply gets added after it.</div>}

      <form
        className="flex items-end gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          reply();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              reply();
            }
          }}
          rows={1}
          placeholder={ask?.reachable ? "Reply to Claude" : "Reply (opens it in a cockpit terminal)"}
          className={`${inputClass} flex-1 min-w-0 h-auto min-h-8 py-1.5 resize-y`}
        />
        <Button size="sm" variant="primary" disabled={busy || !text.trim()}>
          Send
        </Button>
      </form>
      <ErrorNote error={err ?? q.error} />
    </div>
  );
}
