import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import type { Session } from "@cockpit/shared";
import { RootPicker } from "../components/RootPicker";
import { Button, Empty, ErrorNote, inputClass, Loading, Modal, PageHeader, Tabs, Tag } from "../components/ui";
import { api, qs } from "../lib/api";
import { ago, shortPath, usd } from "../lib/format";
import { useCost } from "../lib/cost";
import { useLiveSessions } from "../lib/live";

interface HistoryItem {
  text: string;
  ts: number;
  project: string;
  sessionId?: string;
}

export interface SaidHit {
  id: string;
  title: string | null;
  cwd: string | null;
  lastTs: string | null;
  hits: { entryId: string; ts: string; role: string; snippet: string }[];
}

export const useSaid = (q: string) =>
  useQuery({ queryKey: ["said", q], queryFn: () => api.get<SaidHit[]>(`/sessions/search${qs({ q })}`), enabled: q.trim().length >= 2 });

// FTS snippets mark matches with [[ ]]
export const Snippet = ({ text }: { text: string }) => (
  <>
    {text.split(/(\[\[.*?\]\])/).map((part, i) =>
      part.startsWith("[[") ? (
        <mark key={i} className="bg-amber-soft text-ink rounded-sm px-0.5">
          {part.slice(2, -2)}
        </mark>
      ) : (
        part
      ),
    )}
  </>
);

function Said({ q }: { q: string }) {
  const said = useSaid(q);
  if (q.trim().length < 2) return <Empty>Type at least two letters. Every prompt and answer from every session is searchable.</Empty>;
  if (said.isLoading) return <Loading />;
  if (!said.data?.length) return <Empty>Nothing said matches.</Empty>;
  return (
    <ul className="bg-panel border border-line rounded-lg divide-y divide-line overflow-hidden">
      {said.data.map((s) => (
        <li key={s.id}>
          <Link to="/sessions/$id" params={{ id: s.id }} className="block px-3 py-2.5 hover:bg-ground">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate flex-1">{s.title ?? s.id.slice(0, 8)}</span>
              <span className="text-[12px] text-muted shrink-0">{s.lastTs ? ago(Date.parse(s.lastTs)) : ""}</span>
            </div>
            <div className="text-[12px] text-faint truncate">{shortPath(s.cwd ?? "")}</div>
            {s.hits.map((h) => (
              <div key={h.entryId} className="text-[13px] text-muted mt-1 line-clamp-2">
                <span className="text-faint">{h.role === "user" ? "You: " : "Claude: "}</span>
                <Snippet text={h.snippet} />
              </div>
            ))}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function SessionsPage() {
  const cost = useCost();
  const [tab, setTab] = useState<"sessions" | "said" | "prompts">("sessions");
  const [q, setQ] = useState("");
  const [launching, setLaunching] = useState(false);
  const dq = useDeferredValue(q);
  const live = useLiveSessions();
  const liveById = new Map(live.map((s) => [s.id, s]));

  const sessions = useQuery({ queryKey: ["sessions", dq], queryFn: () => api.get<Session[]>(`/sessions${qs({ q: dq, limit: 300 })}`), enabled: tab === "sessions" });
  const history = useQuery({ queryKey: ["history", dq], queryFn: () => api.get<HistoryItem[]>(`/sessions/history${qs({ q: dq, limit: 150 })}`), enabled: tab === "prompts" });
  const total = sessions.data?.reduce((n, s) => n + (s.costUSD ?? 0), 0) ?? 0;

  return (
    <div className="max-w-[1200px]">
      <PageHeader title="Sessions" sub={sessions.data ? `${sessions.data.length} sessions${cost.hidden ? "" : `, ${usd(total)} ${cost.real ? "in total" : "of API value"}`}` : undefined}>
        <Button variant="primary" onClick={() => setLaunching(true)}>
          New session
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Tabs value={tab} onChange={setTab} items={[{ value: "sessions", label: "Sessions" }, { value: "said", label: "What was said" }, { value: "prompts", label: "Prompt history" }]} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === "sessions" ? "Search title, ticket, folder or branch" : tab === "said" ? "Search what you and Claude said in every session" : "Search everything you've typed"} className={`${inputClass} flex-1 min-w-[220px]`} />
      </div>

      {tab === "said" ? (
        <Said q={dq} />
      ) : tab === "sessions" ? (
        <div className="bg-panel border border-line rounded-lg overflow-hidden">
          {sessions.isLoading && <Loading />}
          <ErrorNote error={sessions.error} />
          {sessions.data?.length === 0 && <Empty>No sessions match.</Empty>}
          <ul className="divide-y divide-line">
            {sessions.data?.map((s) => {
              const st = liveById.get(s.id)?.status ?? s.status;
              return (
                <li key={s.id}>
                  <Link to="/sessions/$id" params={{ id: s.id }} className="flex items-center gap-3 px-3 py-2 hover:bg-ground">
                    <span className={`size-2 rounded-full shrink-0 ${st === "busy" ? "bg-cobalt animate-pulse" : st === "idle" ? "bg-amber" : "bg-line"}`} />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{s.title ?? s.lastPrompt ?? s.id.slice(0, 8)}</div>
                      <div className="truncate text-[12px] text-muted">
                        {shortPath(s.cwd)}
                        {s.branch ? ` on ${s.branch}` : ""}
                      </div>
                    </div>
                    {s.ticket && <Tag tone="cobalt">{s.ticket}</Tag>}
                    {!cost.hidden && <span className="w-16 text-right text-[13px] text-muted" title={cost.label}>{usd(s.costUSD)}</span>}
                    <span className="w-24 text-right text-[12px] text-muted hidden sm:block">{ago(s.updatedAt)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="bg-panel border border-line rounded-lg overflow-hidden">
          {history.isLoading && <Loading />}
          <ul className="divide-y divide-line">
            {history.data?.map((h, i) => (
              <li key={i} className="px-3 py-2">
                <div className="whitespace-pre-wrap break-words line-clamp-4">{h.text}</div>
                <div className="text-[12px] text-muted mt-0.5 flex gap-3">
                  <span>{ago(h.ts)}</span>
                  <span className="truncate">{shortPath(h.project)}</span>
                  {h.sessionId && (
                    <Link to="/sessions/$id" params={{ id: h.sessionId }} className="text-cobalt hover:underline ml-auto shrink-0">
                      Open session
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <LaunchModal open={launching} onClose={() => setLaunching(false)} />
    </div>
  );
}

export function LaunchModal({ open, onClose, cwd: initial }: { open: boolean; onClose: () => void; cwd?: string }) {
  const [cwd, setCwd] = useState(initial ?? "");
  const [prompt, setPrompt] = useState("");
  const [err, setErr] = useState<unknown>();
  const navigate = useNavigate();

  const go = async () => {
    try {
      const t = await api.post<{ id: string }>("/claude/launch", { cwd: cwd || initial, prompt: prompt || undefined });
      onClose();
      navigate({ to: "/terminals", search: { id: t.id } });
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Start a Claude session">
      <div className="space-y-3">
        {!initial && <RootPicker value={cwd} onChange={setCwd} />}
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="First prompt (optional)" className={`${inputClass} h-auto w-full py-2`} />
        <ErrorNote error={err} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!cwd && !initial} onClick={go}>
            Start session
          </Button>
        </div>
      </div>
    </Modal>
  );
}
