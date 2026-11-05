import { type Node, type NodeProps } from "@xyflow/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Run, RunDetail, RunStatus } from "@cockpit/shared";
import { useAgentName } from "../../lib/agent";
import { settledFail } from "../../lib/runGroups";
import { api, qs } from "../../lib/api";
import { ago } from "../../lib/format";
import { useActions, type CardTone } from "./context";
import { useFit } from "./fit";
import { Ports } from "./LinkEdge";

// whose runs it shows: a terminal's (the ones it started, or the agent in it ran) or a ticket's
export type RunsFrom = { term: string; session?: string; node?: string; label: string } | { ticket: string; label: string };
export type RunsData = { from?: RunsFrom; fit?: boolean };
export type RunsCardNode = Node<RunsData, "runs">;

const KIND: Record<string, string> = { unit: "unit", lint: "lint", typecheck: "types", audit: "audit", e2e: "e2e", proof: "proof", verify: "verify", ci: "CI", other: "run" };
const DOT: Record<Shown, string> = { running: "bg-cobalt animate-pulse", pass: "bg-green", fail: "bg-red", cancelled: "bg-line", fixed: "bg-green/40", dismissed: "bg-line" };
const WORD: Record<Shown, string> = { running: "running", pass: "passed", fail: "failed", cancelled: "stopped", fixed: "fixed", dismissed: "hidden" };
const TEXT: Record<Shown, string> = { running: "text-cobalt", pass: "text-green", fail: "text-red", cancelled: "text-faint", fixed: "text-faint", dismissed: "text-faint" };

// how long ago, short enough for a narrow column: 40s, 4m, 2h, 3d
function since(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// One row per check: the tests, the lint, the types, the audit and verify each say how they stand now, however the
// agent worded or ran them along the way, with the runs before as dots (and listed once the row is open). An e2e
// flow, a proof or anything else is about one thing, so each of those keeps a row of its own.
interface Row {
  key: string;
  latest: Run;
  before: Run[];
}
const BY_KIND = new Set(["unit", "lint", "typecheck", "audit", "verify"]);
function rowsOf(runs: Run[]): Row[] {
  const rows = new Map<string, Row>();
  for (const r of [...runs].sort((a, b) => b.startedAt - a.startedAt)) {
    const key = BY_KIND.has(r.kind) ? r.kind : `${r.kind}|${r.command ?? r.name}`;
    const row = rows.get(key);
    if (row) row.before.push(r);
    else rows.set(key, { key, latest: r, before: [] });
  }
  return [...rows.values()];
}

// fixed and dismissed failures show as such, and don't count as failing
type Shown = RunStatus | "fixed" | "dismissed";
const shown = (r: Run): Shown => (!settledFail(r) ? r.status : r.meta.fixedBy ? "fixed" : "dismissed");

// how the card looks from across the canvas: red while the latest of anything fails, then running, then passing
function toneOf(rows: Row[]): CardTone | undefined {
  const s = rows.map((r) => shown(r.latest));
  return s.includes("fail") ? "fail" : s.includes("running") ? "running" : s.includes("pass") ? "pass" : undefined;
}

function Counts({ r }: { r: Run }) {
  const { passed, failed } = r.summary;
  if (passed === undefined && failed === undefined) return null;
  return (
    <span className="tabular-nums shrink-0">
      {failed ? <span className="text-red">{failed}✗ </span> : null}
      {passed !== undefined && <span className="text-green">{passed}✓</span>}
    </span>
  );
}

// a failed run, opened: what failed, the end of its output, what it kept, and the way to get it fixed
function Detail({ r, session, onFail }: { r: Run; session?: string; onFail: (e: unknown) => void }) {
  const qc = useQueryClient();
  const agent = useAgentName();
  const navigate = useNavigate();
  const d = useQuery({ queryKey: ["run-tail", r.id, r.updatedAt], queryFn: () => api.get<RunDetail>(`/runs/${encodeURIComponent(r.id)}?lines=40`) });
  const [sent, setSent] = useState(false);
  const rerun = useMutation({ mutationFn: () => api.post(`/runs/${encodeURIComponent(r.id)}/rerun`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }), onError: onFail });
  const send = useMutation({ mutationFn: () => api.post(`/runs/${encodeURIComponent(r.id)}/send`, { session }), onSuccess: () => setSent(true), onError: onFail });
  const dismiss = useMutation({ mutationFn: (undo: boolean) => api.post(`/runs/${encodeURIComponent(r.id)}/dismiss`, { undo }), onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }), onError: onFail });
  const settled = settledFail(r);
  const tail = (d.data?.tail ?? []).filter((l) => l.trim());
  const failing = r.summary.failing ?? [];
  const picture = r.artifacts.find((x) => x.type === "image" || x.type === "video");
  const src = picture && `/api/runs/${encodeURIComponent(r.id)}/artifacts/${encodeURIComponent(picture.name)}`;
  return (
    <div className="nodrag border-y border-line bg-ground/50 px-3 py-2 flex flex-col gap-2">
      {r.command && <div className="font-mono text-[11px] text-muted truncate" title={r.command}>$ {r.command}</div>}
      {failing.length > 0 && (
        <ul className="text-red">
          {failing.slice(0, 8).map((f) => (
            <li key={f} className="truncate" title={f}>
              ✗ {f}
            </li>
          ))}
          {failing.length > 8 && <li className="text-faint">and {failing.length - 8} more</li>}
        </ul>
      )}
      {picture?.type === "image" && <img src={src} alt={picture.name} className="max-h-44 rounded border border-line object-contain self-start" />}
      {picture?.type === "video" && <video src={src} controls muted className="max-h-44 rounded border border-line self-start" />}
      {tail.length > 0 && (
        <pre className="nowheel max-h-48 overflow-auto rounded bg-panel border border-line font-mono text-[11px] leading-[1.45] p-2 text-muted whitespace-pre-wrap break-all">{tail.slice(-24).join("\n")}</pre>
      )}
      {d.isLoading && <div className="text-faint">Reading its output</div>}
      {settled && (
        <div className="text-muted">
          {r.meta.fixedBy ? (
            <>
              A later run of it passed, so it doesn't count as failing.{" "}
              <button type="button" onClick={() => navigate({ to: "/runs/$id", params: { id: String(r.meta.fixedBy) } })} className="text-cobalt hover:underline">
                See that run
              </button>
            </>
          ) : (
            "You hid it, so it doesn't count as failing."
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {r.status === "fail" && !settled && (session || r.meta.session) && (
          <button type="button" disabled={send.isPending || sent} onClick={() => send.mutate()} className="h-6 px-2 rounded-md bg-cobalt text-on-accent font-medium disabled:opacity-60" title={`Types what failed and the end of its output into ${agent}, asking it to fix it`}>
            {sent ? "Sent" : send.isPending ? "Sending" : `Send to ${agent}`}
          </button>
        )}
        {r.command && r.status !== "running" && (
          <button type="button" disabled={rerun.isPending} onClick={() => rerun.mutate()} className="h-6 px-2 rounded-md border border-line hover:bg-panel disabled:opacity-60">
            {rerun.isPending ? "Starting" : "Run again"}
          </button>
        )}
        <button type="button" onClick={() => navigate({ to: "/runs/$id", params: { id: r.id } })} className="h-6 px-2 rounded-md text-cobalt hover:bg-panel">
          Open the run
        </button>
        {r.status === "fail" && !r.meta.fixedBy && (
          <button type="button" disabled={dismiss.isPending} onClick={() => dismiss.mutate(!!r.meta.dismissed)} className="ml-auto h-6 px-2 rounded-md text-muted hover:text-ink hover:bg-panel disabled:opacity-60" title={r.meta.dismissed ? "Count it as failing again" : "You've seen it and don't need it: it stops counting as failing"}>
            {r.meta.dismissed ? "Show it again" : "Hide"}
          </button>
        )}
      </div>
    </div>
  );
}

// the runs of a check before its latest, newest first, each a click from its own page
function Earlier({ runs }: { runs: Run[] }) {
  const navigate = useNavigate();
  return (
    <div className="nodrag border-b border-line bg-ground/30 py-1">
      <div className="px-3 pb-0.5 text-[11px] text-faint">Before that</div>
      {runs.slice(0, 8).map((b) => {
        const s = shown(b);
        return (
          <button key={b.id} type="button" onClick={() => navigate({ to: "/runs/$id", params: { id: b.id } })} className="w-full flex items-center gap-2 pl-7 pr-3 h-6 text-left hover:bg-ground" data-earlier={b.id} data-status={s} title={b.command ?? b.name}>
            <span className={`size-1.5 rounded-full shrink-0 ${DOT[s].replace(" animate-pulse", "")}`} />
            <span className="truncate flex-1 min-w-0 text-muted">{b.name}</span>
            <span className={`shrink-0 w-12 text-right whitespace-nowrap ${TEXT[s]}`}>{WORD[s]}</span>
            <span className="shrink-0 w-8 text-right text-faint tabular-nums whitespace-nowrap" title={ago(b.startedAt)}>
              {since(b.startedAt)}
            </span>
          </button>
        );
      })}
      {runs.length > 8 && <div className="pl-7 pr-3 h-5 text-[11px] text-faint">and {runs.length - 8} more on the Runs screen</div>}
    </div>
  );
}

function RunRow({ row, open, onToggle, session, onFail }: { row: Row; open: boolean; onToggle: () => void; session?: string; onFail: (e: unknown) => void }) {
  const r = row.latest;
  const s = shown(r);
  return (
    <div data-run={r.id} data-status={s}>
      <button type="button" onClick={onToggle} className={`nodrag w-full flex items-center gap-2 px-3 h-7 text-left hover:bg-ground ${r.status === "running" ? "relative overflow-hidden sweep" : ""}`} aria-expanded={open} title={r.command ?? r.name}>
        <span className={`size-2 rounded-full shrink-0 ${DOT[s]}`} />
        <span className="w-10 shrink-0 text-faint">{KIND[r.kind] ?? r.kind}</span>
        <span className="truncate flex-1 min-w-0">{r.name}</span>
        <Counts r={r} />
        {row.before.length > 0 && (
          <span className="flex items-center gap-0.5 shrink-0" title={`${row.before.length + 1} runs, newest first`}>
            {row.before.slice(0, 5).map((b) => (
              <span key={b.id} className={`size-1.5 rounded-full opacity-70 ${DOT[shown(b)].replace(" animate-pulse", "")}`} />
            ))}
          </span>
        )}
        <span className={`shrink-0 w-12 text-right whitespace-nowrap ${TEXT[s]}`}>{WORD[s]}</span>
        <span className="shrink-0 w-8 text-right text-faint tabular-nums whitespace-nowrap" title={ago(r.startedAt)}>
          {since(r.startedAt)}
        </span>
      </button>
      {open && <Detail r={r} session={session} onFail={onFail} />}
      {open && row.before.length > 0 && <Earlier runs={row.before} />}
    </div>
  );
}

// The runs of whatever it's linked to (tests, lint, typecheck, e2e, proofs, CI), as they happen: a terminal's are
// the ones started in it and the ones its agent ran, a ticket's the ones cockpit filed under it. A failing one
// opens to what failed, and can be sent to the agent to fix or run again.
export function RunsCard({ id, data, selected }: NodeProps<RunsCardNode>) {
  const a = useActions();
  const agent = useAgentName();
  const from = data.from;
  const f = !from ? undefined : "term" in from ? { terminal: from.term, session: from.session, limit: 60 } : { ticket: from.ticket, limit: 60 };
  // the socket's "run" event refetches every runs query, so this stays live without polling
  const q = useQuery({ queryKey: ["runs", f], queryFn: () => api.get<Run[]>(`/runs${qs({ ...f })}`), enabled: !!f });
  const rows = rowsOf(q.data ?? []);
  const tone = toneOf(rows);
  const [open, setOpen] = useState<string>();
  // a row opens by itself when its latest run fails, once
  const failed = rows.find((r) => shown(r.latest) === "fail")?.latest.id;
  const [opened, setOpened] = useState<string>();
  if (failed && failed !== opened) {
    setOpened(failed);
    setOpen(rows.find((r) => r.latest.id === failed)?.key);
  }
  useEffect(() => a.tone(id, tone), [id, tone, a]);
  const fit = useFit({ id, selected, fit: data.fit, max: 560, minWidth: 300, minHeight: 120 });
  const count = (s: Shown) => rows.filter((r) => shown(r.latest) === s).length;
  // just the failing ones, from the count in the header; back to all once nothing fails
  const [onlyFailing, setOnlyFailing] = useState(false);
  const filtering = onlyFailing && count("fail") > 0;
  const list = filtering ? rows.filter((r) => shown(r.latest) === "fail") : rows;
  const border = selected ? "border-cobalt" : tone === "fail" ? "border-red border-2" : "border-line";
  const session = from && "term" in from ? from.session : undefined;
  return (
    <div className={`w-full flex flex-col rounded-lg border bg-panel shadow-lg overflow-hidden text-[12px] ${border}`} style={fit.style} data-runs={id} data-tone={tone}>
      {fit.resizer}
      <Ports />
      <div className="card-handle cursor-grab active:cursor-grabbing flex items-center gap-2 h-8 pl-2.5 pr-1 bg-raised border-b border-line shrink-0" onDoubleClick={() => a.bringUp(id)} title="Drag to move, double-click to see it at 100%">
        <span className="font-medium">Runs</span>
        {from && <span className="truncate text-faint">{from.label}</span>}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {count("fail") > 0 && (
            <button type="button" onClick={() => setOnlyFailing(!filtering)} className={`nodrag h-5 px-1.5 -mx-1.5 rounded text-red ${filtering ? "bg-red-soft" : "hover:bg-red-soft"}`} aria-pressed={filtering} title={filtering ? "Show every check again" : "Show only what's failing"}>
              {count("fail")} failing
            </button>
          )}
          {count("running") > 0 && <span className="text-cobalt">{count("running")} running</span>}
          {count("pass") > 0 && <span className="text-green">{count("pass")} passing</span>}
        </span>
        <button type="button" onClick={() => a.removeCard(id)} className="nodrag size-6 grid place-items-center rounded text-faint hover:text-red hover:bg-ground" title="Take this card off the canvas" aria-label="Remove runs card">
          ×
        </button>
      </div>
      <div className="nowheel flex-auto min-h-0 overflow-y-auto py-1">
        {!from ? (
          <div className="px-4 py-6 text-center text-muted">Draw a line from this card to a terminal or a ticket, and it shows their tests, lint, e2e and CI runs as they happen.</div>
        ) : q.error ? (
          <div className="px-4 py-6 text-center text-muted">Couldn't read the runs: {q.error instanceof Error ? q.error.message : String(q.error)}</div>
        ) : q.isLoading ? (
          <div className="px-4 py-6 text-center text-faint">Reading the runs</div>
        ) : !rows.length ? (
          <div className="px-4 py-6 text-center text-muted">No runs yet. The tests, lint, typecheck and e2e that {agent} or you run {"term" in from ? "here" : "for this ticket"} show up as they go.</div>
        ) : (
          list.map((r) => <RunRow key={r.key} row={r} open={open === r.key} onToggle={() => setOpen(open === r.key ? undefined : r.key)} session={session} onFail={a.fail} />)
        )}
      </div>
    </div>
  );
}
