import { useAgentName, useClaudeMain } from "../lib/agent";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Run, RunKind, RunStatus, RunStep } from "@cockpit/shared";
import { JobLog } from "../components/JobLog";
import { PrSummary } from "../components/PrSummary";
import { runSomething } from "../components/RunSomething";
import { RunVideo } from "../components/VideoTrim";
import { Button, Empty, ErrorNote, Loading, PageHeader, Tag, inputClass } from "../components/ui";
import { api } from "../lib/api";
import { markSeen } from "../lib/badges";
import { useLive } from "../lib/live";
import { ago, duration, shortPath } from "../lib/format";
import { useJobs, usePrs, useRun, useRuns, useTickets, useWorktrees, type RunsFilter } from "../lib/queries";
import { GROUP_BYS, groupRuns, prOf, rowPr, rowStatus, type GroupBy, type RunGroup, type RunRow } from "../lib/runGroups";

const KINDS: { value: RunKind; label: string }[] = [
  { value: "unit", label: "Tests" },
  { value: "lint", label: "Lint" },
  { value: "typecheck", label: "Typecheck" },
  { value: "audit", label: "Audit" },
  { value: "e2e", label: "E2E" },
  { value: "proof", label: "E2E with video" },
  { value: "verify", label: "Verify" },
  { value: "ci", label: "CI" },
  { value: "other", label: "Other" },
];
const kindLabel = (k: RunKind) => KINDS.find((x) => x.value === k)?.label ?? k;
const STATUSES: RunStatus[] = ["running", "pass", "fail", "cancelled"];
const statusTone = (s: RunStatus) => (s === "running" ? "cobalt" : s === "pass" ? "green" : s === "fail" ? "red" : "faint");
const statusLabel = (r: Run) => (r.status === "running" ? (r.meta.phase && r.meta.phase !== "running" ? r.meta.phase : "running") : r.status === "pass" ? "passed" : r.status === "fail" ? (r.exitCode ? `failed (${r.exitCode})` : "failed") : "cancelled");
const SOURCES: Record<string, string> = { hook: "Claude", wrapper: "cockpit run", terminal: "terminal", manual: "you", verify: "verify", ci: "CI", mcp: "Claude", script: "script", codex: "Codex", gemini: "Gemini" };
const sourceLabel = (s: string) => SOURCES[s] ?? (s.startsWith("plugin:") ? s.slice(7) : s);
const took = (r: Run) => duration((r.endedAt ?? Date.now()) - r.startedAt);

function Counts({ r }: { r: Run }) {
  const { passed, failed, skipped } = r.summary;
  if (passed === undefined && failed === undefined) return null;
  return (
    <span className="text-[12px] tabular-nums">
      {failed ? <span className="text-red">{failed} failed </span> : null}
      {passed !== undefined && <span className="text-green">{passed} passed</span>}
      {skipped ? <span className="text-faint"> · {skipped} skipped</span> : null}
    </span>
  );
}

// You're looking at runs, so the sidebar's "failed since you last looked" starts again, now and whenever one
// ends while you're here.
function useSeen() {
  useEffect(() => void markSeen("/runs"), []);
  useLive((ev) => ev.type === "run" && ev.run.status !== "running" && void markSeen("/runs"), []);
}

const GROUP_LABEL: Record<GroupBy, string> = { ticket: "By ticket", day: "By day", kind: "By kind", none: "Not grouped" };

// which groups you folded away, kept in this browser
const FOLDED = "cockpit.runs.folded";
function useFolded() {
  const [folded, set] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOLDED) || "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    set((old) => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      try {
        localStorage.setItem(FOLDED, JSON.stringify([...next].slice(-200)));
      } catch {}
      return next;
    });
  return { folded, toggle };
}

// The PR a run ran against, opening on the code host; the row is a link already, so this can't be one
function PrRef({ r }: { r: Run }) {
  const n = prOf(r);
  if (!n) return null;
  const url = typeof r.meta.prUrl === "string" ? r.meta.prUrl : undefined;
  const title = typeof r.meta.branch === "string" ? `On ${r.meta.branch}${typeof r.meta.prBase === "string" ? `, into ${r.meta.prBase}` : ""}` : undefined;
  if (!url) return <span title={title}>#{n}</span>;
  return (
    <span
      role="link"
      title={title}
      onClick={(e) => (e.preventDefault(), e.stopPropagation(), window.open(url, "_blank", "noreferrer"))}
      className="text-cobalt hover:underline cursor-pointer"
    >
      #{n}
    </span>
  );
}

// one run as a row of the list: what it is, where, how it went and when
function RunLine({ r, small }: { r: Run; small?: boolean }) {
  return (
    <Link to="/runs/$id" params={{ id: r.id }} className={`flex items-center gap-3 px-3 ${small ? "py-1.5 pl-8 text-[13px]" : "py-2.5"} hover:bg-ground ${r.status === "running" ? "relative overflow-hidden sweep" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Tag tone={statusTone(r.status)}>{statusLabel(r)}</Tag>
          {!small && <Tag tone="faint">{kindLabel(r.kind)}</Tag>}
          <span className={`${small ? "" : "font-medium"} truncate`}>{r.name}</span>
          {r.node && <span className="shrink-0 text-[12px] text-faint">on {r.node}</span>}
        </div>
        {!small && (
          <div className="text-[12px] text-muted truncate mt-0.5 flex gap-2">
            {r.ticket && <span className="text-ink">{r.ticket}</span>}
            <PrRef r={r} />
            {r.worktree && <span>{r.worktree.split("/").pop()}</span>}
            {r.command && r.command !== r.name && <span className="font-mono truncate">{r.command}</span>}
          </div>
        )}
      </div>
      <Counts r={r} />
      <span className="text-[12px] text-muted w-24 text-right hidden sm:block">{sourceLabel(r.source)}</span>
      <span className="text-[13px] text-muted w-14 text-right tabular-nums">{took(r)}</span>
      <span className="text-[12px] text-muted w-24 text-right hidden sm:block">{ago(r.startedAt)}</span>
    </Link>
  );
}

const rowKey = (row: RunRow) => (row.type === "ci" ? `ci:${row.sha}` : row.run.id);

// A row of a group: one run, the latest of a run done more than once, or a commit's CI checks; the last two open
function GroupRow({ row }: { row: RunRow }) {
  const [open, setOpen] = useState(false);
  if (row.type === "single") return <RunLine r={row.run} />;
  if (row.type === "repeat")
    return (
      <div>
        <div className="flex items-center">
          <div className="flex-1 min-w-0">
            <RunLine r={row.run} />
          </div>
          <button onClick={() => setOpen(!open)} className="shrink-0 mr-2 px-2 h-7 rounded text-[12px] text-muted hover:text-ink hover:bg-ground" title="Its earlier runs">
            {open ? "Hide" : `+${row.earlier.length} earlier`}
          </button>
        </div>
        {open && row.earlier.map((r) => <RunLine key={r.id} r={r} small />)}
      </div>
    );
  const count = (s: RunStatus) => row.checks.filter((r) => r.status === s).length;
  const status = rowStatus(row);
  const parts = [count("pass") && `${count("pass")} passed`, count("fail") && `${count("fail")} failed`, count("running") && `${count("running")} running`, count("cancelled") && `${count("cancelled")} cancelled`].filter(Boolean);
  const prUrl = typeof row.latest.meta.prUrl === "string" ? row.latest.meta.prUrl : undefined;
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}
        className={`w-full text-left flex items-center gap-3 px-3 py-2.5 hover:bg-ground cursor-pointer ${status === "running" ? "relative overflow-hidden sweep" : ""}`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Tag tone={statusTone(status)}>{status === "pass" ? "passed" : status === "fail" ? "failed" : status}</Tag>
            <Tag tone="faint">CI</Tag>
            <span className="font-medium truncate">
              {row.checks.length} check{row.checks.length === 1 ? "" : "s"} on <span className="font-mono">{row.sha.slice(0, 7)}</span>
            </span>
          </div>
          <div className="text-[12px] text-muted truncate mt-0.5 flex gap-2">
            {row.pr && <span className="text-ink">PR #{row.pr}</span>}
            <span>{parts.join(", ")}</span>
          </div>
        </div>
        {prUrl && (
          <a href={prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-[12px] text-cobalt hover:underline">
            On GitHub
          </a>
        )}
        <span className="text-[12px] text-muted w-24 text-right">{open ? "Hide" : "Each check"}</span>
        <span className="text-[12px] text-muted w-24 text-right hidden sm:block">{ago(row.latest.startedAt)}</span>
      </div>
      {open &&
        [...row.checks]
          .sort((a, b) => Number(b.status === "fail") - Number(a.status === "fail") || a.name.localeCompare(b.name))
          .map((r) => <RunLine key={r.id} r={r} small />)}
    </div>
  );
}

function Group({ g, folded, onToggle, onSummary }: { g: RunGroup; folded: boolean; onToggle: () => void; onSummary: (ticket: string) => void }) {
  // a ticket's name, and its open PRs when none of its runs said which they ran against
  const tickets = useTickets();
  const prs = usePrs();
  const name = g.ticket ? tickets.data?.tickets.find((t) => t.key === g.ticket)?.summary : undefined;
  const titles = new Map((prs.data?.mine ?? []).map((p) => [p.number, p.title]));
  const worktrees = useWorktrees();
  const theirs = () => {
    const mine = prs.data?.mine ?? [];
    const own = mine.filter((p) => p.ticket === g.ticket);
    if (own.length) return own;
    // a story worked on a sub-task's branch: the PR of its worktree's branch
    const branches = new Set((worktrees.data ?? []).filter((w) => w.ticket === g.ticket).map((w) => w.branch));
    return mine.filter((p) => branches.has(p.branch));
  };
  const shown = g.prs.length || !g.ticket ? g.prs : theirs().map((p) => ({ number: p.number, url: p.url }));
  return (
    <section className="bg-panel border border-line rounded-lg overflow-hidden">
      {/* not a button: a ticket's link sits inside it */}
      <div role="button" tabIndex={0} onClick={onToggle} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle())} className="w-full flex items-center gap-3 px-3 py-2 bg-ground/60 hover:bg-ground text-left cursor-pointer select-none">
        <span className="text-faint w-3">{folded ? "▸" : "▾"}</span>
        {g.ticket ? (
          <Link to="/tickets" search={{ key: g.ticket }} onClick={(e) => e.stopPropagation()} className="font-semibold hover:text-cobalt shrink-0">
            {g.label}
          </Link>
        ) : (
          <span className="font-semibold">{g.label}</span>
        )}
        {name && (
          <span className="text-[13px] text-muted truncate min-w-0" title={name}>
            {name}
          </span>
        )}
        {shown.map((p) =>
          p.url ? (
            <a key={p.number} href={p.url} target="_blank" rel="noreferrer" title={titles.get(p.number)} onClick={(e) => e.stopPropagation()} className="text-[12px] text-cobalt hover:underline shrink-0">
              #{p.number}
            </a>
          ) : (
            <span key={p.number} className="text-[12px] text-muted">
              #{p.number}
            </span>
          ),
        )}
        {g.running > 0 && <span className="text-[12px] text-cobalt shrink-0">● {g.running} running</span>}
        {g.failing > 0 && <span className="text-[12px] text-red shrink-0">{g.failing} failing</span>}
        <span className="flex-1" />
        {g.ticket && (
          <button
            onClick={(e) => (e.stopPropagation(), onSummary(g.ticket!))}
            className="shrink-0 px-2 h-6 rounded text-[12px] text-muted hover:text-ink hover:bg-raised border border-transparent hover:border-line"
            title="An image of its checks to paste into the PR"
          >
            Image for PR
          </button>
        )}
        <span className="text-[12px] text-faint shrink-0">
          {g.rows.length} {g.rows.length === 1 ? "row" : "rows"} · last {ago(g.latestAt)}
        </span>
      </div>
      {!folded && (
        <div className="divide-y divide-line border-t border-line">
          {g.prs.length > 1 || (g.prs.length === 1 && g.rows.some((row) => !rowPr(row)))
            ? // runs on more than one PR (a worktree with a stack of them): under the PR each ran against
              [...g.prs.map((p) => p.number), undefined].map((n) => {
                const rows = g.rows.filter((row) => rowPr(row) === n);
                if (!rows.length) return null;
                const branch = rows.map((row) => (row.type === "ci" ? row.latest : row.run)).find((r) => typeof r.meta.branch === "string")?.meta.branch as string | undefined;
                return (
                  <div key={n ?? "none"}>
                    <div className="px-3 py-1.5 text-[12px] text-muted bg-ground/30 flex gap-2">
                      <span className="text-ink font-medium">{n ? `PR #${n}` : "No PR"}</span>
                      {branch && <span className="font-mono truncate">{branch}</span>}
                    </div>
                    <div className="divide-y divide-line">
                      {rows.map((row) => (
                        <GroupRow key={rowKey(row)} row={row} />
                      ))}
                    </div>
                  </div>
                );
              })
            : g.rows.map((row) => <GroupRow key={rowKey(row)} row={row} />)}
        </div>
      )}
    </section>
  );
}

export function RunsPage() {
  useSeen();
  const agent = useAgentName();
  const claudeMain = useClaudeMain();
  const search = useSearch({ from: "/runs" });
  const navigate = useNavigate({ from: "/runs" });
  const f: RunsFilter = {
    kind: KINDS.some((k) => k.value === search.kind) ? (search.kind as RunKind) : undefined,
    status: STATUSES.includes(search.status as RunStatus) ? (search.status as RunStatus) : undefined,
    ticket: search.ticket,
    worktree: search.worktree,
  };
  const by: GroupBy = GROUP_BYS.includes(search.group as GroupBy) ? (search.group as GroupBy) : "ticket";
  // grouped, the collapsed rows want their earlier attempts too
  const runs = useRuns(by === "none" ? f : { ...f, limit: 500 });
  const worktrees = useWorktrees();
  const { folded, toggle } = useFolded();
  const nameOf = (path: string) => worktrees.data?.find((w) => w.path === path)?.name ?? path.split("/").filter(Boolean).pop() ?? path;
  const groups = runs.data ? groupRuns(runs.data, by, (k) => kindLabel(k as RunKind), nameOf) : [];
  const set = (patch: Partial<RunsFilter>) => navigate({ search: (s) => ({ ...s, ...patch }), replace: true });
  const filtered = !!(f.kind || f.status || f.ticket || f.worktree);

  return (
    <div className="max-w-[1100px]">
      <PageHeader title="Runs" sub="Tests, lint, typechecks, audits, E2E runs and their videos, verify and CI checks, from your agent, terminals, cockpit run and plugins.">
        <Button variant="primary" onClick={() => runSomething.open({ worktree: f.worktree, ticket: f.ticket })}>
          Run something
        </Button>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select value={f.kind ?? ""} onChange={(e) => set({ kind: (e.target.value || undefined) as RunKind })} className={inputClass} aria-label="Kind">
          <option value="">Every kind</option>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <select value={f.status ?? ""} onChange={(e) => set({ status: (e.target.value || undefined) as RunStatus })} className={inputClass} aria-label="Status">
          <option value="">Any result</option>
          <option value="running">Running</option>
          <option value="pass">Passed</option>
          <option value="fail">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <input
          defaultValue={f.ticket ?? ""}
          key={f.ticket ?? ""}
          placeholder="Ticket"
          onBlur={(e) => set({ ticket: e.target.value.trim().toUpperCase() || undefined })}
          onKeyDown={(e) => e.key === "Enter" && set({ ticket: e.currentTarget.value.trim().toUpperCase() || undefined })}
          className={`${inputClass} w-32`}
        />
        <select value={f.worktree ?? ""} onChange={(e) => set({ worktree: e.target.value || undefined })} className={`${inputClass} max-w-[260px]`} aria-label="Worktree">
          <option value="">Every worktree</option>
          {worktrees.data
            ?.filter((w) => !w.main)
            .map((w) => (
              <option key={w.path} value={w.path}>
                {w.name}
              </option>
            ))}
          {f.worktree && !worktrees.data?.some((w) => w.path === f.worktree) && <option value={f.worktree}>{shortPath(f.worktree)}</option>}
        </select>
        <select value={by} onChange={(e) => navigate({ search: (s) => ({ ...s, group: e.target.value === "ticket" ? undefined : e.target.value }), replace: true })} className={inputClass} aria-label="Group">
          {GROUP_BYS.map((g) => (
            <option key={g} value={g}>
              {GROUP_LABEL[g]}
            </option>
          ))}
        </select>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => navigate({ search: (s) => ({ group: s.group }), replace: true })}>
            Clear
          </Button>
        )}
      </div>
      {runs.isLoading && <Loading />}
      <ErrorNote error={runs.error} />
      {runs.data?.length === 0 &&
        (filtered ? (
          <Empty>No runs match these filters.</Empty>
        ) : (
          <Empty>
            {claudeMain
              ? "No runs yet. Install the Claude hook in Settings → Board and automation to record the tests, lint and audits Claude runs, or wrap a command in "
              : `No runs yet. The tests, lint and audits ${agent} runs in cockpit's tasks show up here. Wrap any other command in `}
            <code className="font-mono">bin/cockpit run --</code>.
          </Empty>
        ))}
      {search.summary && <PrSummary ticket={search.summary} open onClose={() => navigate({ search: (s) => ({ ...s, summary: undefined }), replace: true })} />}
      {!!runs.data?.length && by === "none" && (
        <div className="bg-panel border border-line rounded-lg divide-y divide-line">
          {runs.data.map((r) => (
            <RunLine key={r.id} r={r} />
          ))}
        </div>
      )}
      {!!runs.data?.length && by !== "none" && (
        <div className="space-y-3">
          {groups.map((g) => (
            <Group key={g.key} g={g} folded={folded.has(`${by}:${g.key}`)} onToggle={() => toggle(`${by}:${g.key}`)} onSummary={(t) => navigate({ search: (s) => ({ ...s, summary: t }), replace: true })} />
          ))}
        </div>
      )}
    </div>
  );
}

const stepTone: Record<RunStep["state"], string> = { running: "text-cobalt", ok: "text-green", failed: "text-red", skipped: "text-faint", section: "text-ink font-medium" };
const stepMark: Record<RunStep["state"], string> = { running: "…", ok: "✓", failed: "✗", skipped: "–", section: "" };

// deeper than this, steps line up instead of walking off the side
const MAX_DEPTH = 6;

// once a run is over, a step still open finished with it if it passed, and didn't run if not
// A plugin's panel on a run, as tall as what it shows: it's on the same origin, so its page can be measured
function RunPanel({ src, title }: { src: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [watch, setWatch] = useState<ResizeObserver>();
  useEffect(() => () => watch?.disconnect(), [watch]);
  const measure = () => {
    const doc = frame.current?.contentDocument;
    if (!doc?.body) return;
    // the body, not the document: that's never shorter than the frame, so it would only ever grow
    const fit = () => setHeight(Math.min(Math.max(Math.ceil(doc.body.getBoundingClientRect().height) + 2, 40), 900));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(doc.body);
    setWatch(ro);
  };
  return <iframe ref={frame} src={src} title={title} onLoad={measure} style={{ height }} className="w-full border border-line rounded-lg bg-panel block" allow="clipboard-write; fullscreen" />;
}

function Steps({ steps, done, passed }: { steps: RunStep[]; done: boolean; passed: boolean }) {
  const closed = passed ? "ok" : "skipped";
  return (
    <div className="bg-panel border border-line rounded-lg px-3 py-2 max-h-[420px] overflow-y-auto overflow-x-hidden text-[13px]">
      {steps.map((s, i) => (
        <div
          key={i}
          className={`flex gap-2 min-w-0 ${stepTone[done && s.state === "running" ? closed : s.state]} ${s.state === "section" ? "mt-2 first:mt-0" : ""}`}
          style={{ paddingLeft: Math.min(s.depth, MAX_DEPTH) * 14 }}
          title={s.depth > MAX_DEPTH ? `${s.depth} levels deep` : undefined}
        >
          <span className="w-3 shrink-0 text-center">{stepMark[done && s.state === "running" ? closed : s.state]}</span>
          <span className="min-w-0 break-words">{s.text}</span>
        </div>
      ))}
    </div>
  );
}

export function RunPage() {
  useSeen();
  const { id } = useParams({ from: "/runs/$id" });
  const navigate = useNavigate();
  const run = useRun(id);
  const jobs = useJobs();
  const pre = useRef<HTMLPreElement>(null);
  const rerun = useMutation({ mutationFn: () => api.post<{ id: string; runId: string }>(`/runs/${id}/rerun`), onSuccess: (t) => navigate({ to: "/terminals", search: { id: t.id } }) });
  const send = useMutation({ mutationFn: () => api.post(`/runs/${id}/send`) });
  const remove = useMutation({ mutationFn: () => api.del(`/runs/${id}`), onSuccess: () => navigate({ to: "/runs" }) });
  // Maestro redraws its live view with screens of empty lines; a gap of more than one line says nothing
  const tail = run.data?.tail.join("\n").replace(/\n\s*\n(\s*\n)+/g, "\n\n").replace(/^\s*\n/, "");
  useEffect(() => {
    if (pre.current && run.data?.status === "running") pre.current.scrollTop = pre.current.scrollHeight;
  }, [tail, run.data?.status]);

  if (run.isLoading) return <Loading />;
  const r = run.data;
  if (!r) return <ErrorNote error={run.error} />;
  const job = typeof r.meta.job === "string" ? jobs.data?.find((j) => j.id === r.meta.job) : undefined;
  const progress = typeof r.meta.progress === "number" && r.status === "running" ? r.meta.progress : undefined;
  const live = r.status === "running" && r.meta.live === true;
  const files = (name: string) => `/api/runs/${encodeURIComponent(r.id)}/artifacts/${encodeURIComponent(name)}`;

  return (
    <div className="max-w-[1100px] space-y-4">
      <div>
        <div className="text-[13px] text-muted mb-1">
          <Link to="/runs" className="hover:text-ink">
            Runs
          </Link>
        </div>
        <PageHeader
          title={r.name}
          sub={
            <span className="flex flex-wrap items-center gap-2">
              <Tag tone={statusTone(r.status)}>{statusLabel(r)}</Tag>
              <Tag tone="faint">{kindLabel(r.kind)}</Tag>
              <span>
                from {sourceLabel(r.source)}, {ago(r.startedAt)}, {r.status === "running" ? "running for" : "took"} {took(r) || "under a second"}
              </span>
              <Counts r={r} />
            </span>
          }
        >
          <div className="flex flex-wrap gap-2">
            {r.status === "fail" && (r.worktree || r.meta.session) && (
              <Button onClick={() => send.mutate()} disabled={send.isPending} title="Types what failed and the end of its output into the session that ran it, or the one in its worktree">
                {send.isSuccess ? "Sent" : "Send failure to the session"}
              </Button>
            )}
            {r.command && r.status !== "running" && (
              <Button variant="primary" onClick={() => rerun.mutate()} disabled={rerun.isPending}>
                Rerun
              </Button>
            )}
            {r.status !== "running" && (
              <Button variant="danger" onClick={() => confirm("Delete this run with its output and files?") && remove.mutate()} disabled={remove.isPending}>
                Delete
              </Button>
            )}
          </div>
        </PageHeader>
        <ErrorNote error={send.error ?? rerun.error ?? remove.error} />
      </div>

      <div className="bg-panel border border-line rounded-lg px-3 py-2.5 text-[13px] grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {r.ticket && (
          <>
            <span className="text-muted">Ticket</span>
            <span className="flex gap-3">
              <Link to="/tickets" search={{ key: r.ticket }} className="text-cobalt hover:underline">
                {r.ticket}
              </Link>
              <Link to="/runs" search={{ ticket: r.ticket }} className="text-muted hover:text-ink">
                its runs
              </Link>
            </span>
          </>
        )}
        {r.worktree && (
          <>
            <span className="text-muted">Worktree</span>
            <span className="flex gap-3 min-w-0">
              <Link to="/code" search={{ root: r.worktree }} className="text-cobalt hover:underline truncate">
                {shortPath(r.worktree)}
              </Link>
              <Link to="/runs" search={{ worktree: r.worktree }} className="text-muted hover:text-ink shrink-0">
                its runs
              </Link>
            </span>
          </>
        )}
        {r.meta.session && (
          <>
            <span className="text-muted">Session</span>
            <Link to="/sessions/$id" params={{ id: r.meta.session }} className="text-cobalt hover:underline truncate">
              {r.meta.session}
            </Link>
          </>
        )}
        {r.meta.terminal && r.status === "running" && (
          <>
            <span className="text-muted">Terminal</span>
            <Link to="/terminals" search={{ id: r.meta.terminal }} className="text-cobalt hover:underline">
              Open its terminal
            </Link>
          </>
        )}
        {typeof r.meta.url === "string" && (
          <>
            <span className="text-muted">Link</span>
            <a href={r.meta.url} target="_blank" rel="noreferrer" className="text-cobalt hover:underline truncate">
              {r.meta.url}
            </a>
          </>
        )}
        {r.command && (
          <>
            <span className="text-muted">Command</span>
            <code className="font-mono text-[12px] break-all">{r.command}</code>
          </>
        )}
        {r.cwd && (
          <>
            <span className="text-muted">Folder</span>
            <span className="truncate">{shortPath(r.cwd)}</span>
          </>
        )}
        {r.exitCode !== undefined && (
          <>
            <span className="text-muted">Exit code</span>
            <span className="tabular-nums">{r.exitCode}</span>
          </>
        )}
        {typeof r.meta.savedTo === "string" && (
          <>
            <span className="text-muted">Saved to</span>
            <span className="break-all">{r.meta.savedTo}</span>
          </>
        )}
      </div>

      {progress !== undefined && (
        <div className="h-1.5 rounded bg-ground overflow-hidden">
          <div className="h-full bg-cobalt transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {r.meta.error && <ErrorNote error={r.meta.error} />}

      {live && <LiveScreen runId={r.id} steps={r.steps} />}

      {(() => {
        // what the plugins and the run say about it, beside its video when it has one
        const info = (
          <>
          {r.panels.map((p) => (
            <RunPanel key={p.url} src={`${p.url}${p.url.includes("?") ? "&" : "?"}run=${encodeURIComponent(r.id)}`} title={p.plugin} />
          ))}

          {!!r.summary.failing?.length && (
            <section>
              <h2 className="font-semibold mb-1.5">Failing</h2>
              <ul className="bg-panel border border-line rounded-lg px-3 py-2 text-[13px] text-red space-y-0.5">
                {r.summary.failing.map((f) => (
                  <li key={f} className="break-words">
                    {f}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {r.steps.length > 0 && !live && !r.panels.some((p) => p.steps) && (
            <section>
              <h2 className="font-semibold mb-1.5">Steps</h2>
              <Steps steps={r.steps} done={r.status !== "running"} passed={r.status === "pass"} />
            </section>
          )}
          </>
        );
        const videos = r.artifacts.filter((a) => a.type === "video");
        const rest = r.artifacts.filter((a) => a.type !== "video");
        const fileList = (list: typeof r.artifacts) =>
          list.map((a) =>
            a.type === "video" ? (
              <RunVideo key={a.name} runId={r.id} a={a} url={files(a.name)} />
            ) : a.type === "image" ? (
              <a key={a.name} href={files(a.name)} target="_blank" rel="noreferrer" className="block">
                <img src={files(a.name)} alt={a.name} className="max-h-[50vh] max-w-full rounded-lg border border-line" />
              </a>
            ) : (
              <a key={a.name} href={files(a.name)} target="_blank" rel="noreferrer" className="block text-[13px] text-cobalt hover:underline">
                {a.name}
              </a>
            ),
          );
        const side = !live && videos.length > 0;
        return (
          <>
            {side ? (
              <div className="flex flex-wrap items-start gap-4">
                <div className="space-y-2 max-w-full">{fileList(videos)}</div>
                <div className="flex-1 min-w-[280px] space-y-4">{info}</div>
              </div>
            ) : (
              info
            )}
            {(side ? rest : r.artifacts).length > 0 && (
              <section className="space-y-2">
                <h2 className="font-semibold">Files</h2>
                {fileList(side ? rest : r.artifacts)}
              </section>
            )}
          </>
        );
      })()}

      <section>
        <div className="flex items-center gap-3 mb-1.5">
          <h2 className="font-semibold flex-1">Output</h2>
          <a href={`/api/runs/${encodeURIComponent(r.id)}/log`} target="_blank" rel="noreferrer" className="text-[13px] text-muted hover:text-ink">
            Full log
          </a>
        </div>
        {job && job.code === undefined ? (
          <JobLog job={job} />
        ) : (
          <pre ref={pre} className="font-mono text-[12px] whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto bg-panel border border-line rounded-lg px-3 py-2 text-muted">
            {tail || (r.status === "running" ? "Nothing yet" : "No output was recorded")}
          </pre>
        )}
      </section>
    </div>
  );
}

// What a recorded run's screen shows right now, kept current while it records, with its steps beside it. The
// virtual screen is bigger than the browser on it, so the picture is cut to what's ever been drawn on it (the dark
// rest is the empty screen). Each picture is loaded before it replaces the one on show, so it never flickers.
function LiveScreen({ runId, steps }: { runId: string; steps: RunStep[] }) {
  const view = useRef<HTMLCanvasElement>(null);
  const box = useRef<{ x0: number; y0: number; x1: number; y1: number } | undefined>(undefined);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    const scan = document.createElement("canvas");
    const next = () => {
      const img = new Image();
      img.onload = () => {
        if (!on) return;
        // where anything's been on the screen, looked for on a small copy, and only ever grown so the view holds still
        const k = 8;
        scan.width = Math.ceil(img.width / k);
        scan.height = Math.ceil(img.height / k);
        const sc = scan.getContext("2d", { willReadFrequently: true })!;
        sc.drawImage(img, 0, 0, scan.width, scan.height);
        const px = sc.getImageData(0, 0, scan.width, scan.height).data;
        for (let y = 0; y < scan.height; y++)
          for (let x = 0; x < scan.width; x++) {
            const i = (y * scan.width + x) * 4;
            if (px[i] + px[i + 1] + px[i + 2] < 36) continue;
            const b = box.current;
            box.current = b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
          }
        const b = box.current;
        const [sx, sy] = b ? [b.x0 * k, b.y0 * k] : [0, 0];
        const [sw, sh] = b ? [Math.min(img.width, (b.x1 + 1) * k) - sx, Math.min(img.height, (b.y1 + 1) * k) - sy] : [img.width, img.height];
        const c = view.current;
        if (c) {
          c.width = sw;
          c.height = sh;
          c.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
          setShown(true);
        }
        timer = setTimeout(next, 500);
      };
      img.onerror = () => on && (timer = setTimeout(next, 1000));
      img.src = `/api/runs/${encodeURIComponent(runId)}/live.jpg?t=${Date.now()}`;
    };
    next();
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [runId]);
  return (
    <section>
      <h2 className="font-semibold mb-1.5 flex items-center gap-2">
        <span className="size-2 rounded-full bg-red animate-pulse" />
        Live
      </h2>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
        <div className="rounded-lg border border-line bg-black overflow-hidden">
          <canvas ref={view} className={`w-full h-auto max-h-[70vh] object-contain block ${shown ? "" : "hidden"}`} aria-label="The screen as it's being recorded" />
          {!shown && <div className="h-[240px] grid place-items-center text-muted text-[13px]">Waiting for the screen</div>}
        </div>
        <div>
          <h3 className="text-[13px] font-semibold mb-1">Steps</h3>
          {steps.length ? <Steps steps={steps} done={false} passed={false} /> : <div className="bg-panel border border-line rounded-lg px-3 py-2 text-[13px] text-muted">None yet. They show as each test ends.</div>}
        </div>
      </div>
    </section>
  );
}
