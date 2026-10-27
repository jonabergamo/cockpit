import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { BoardCard, Machine, Reviewer } from "@cockpit/shared";
import { api, qs } from "../lib/api";
import { ago, shortPath } from "../lib/format";
import { useOpenSession } from "../lib/openSession";
import { useAppConfig, useJobs } from "../lib/queries";
import { statusLook } from "../lib/status";
import { asPr } from "../pages/Board";
import { PrBadge } from "../pages/Tickets";
import { PrFix } from "./PrFix";
import { ReplyPanel } from "./ReplyPanel";
import { DiffReview } from "./DiffReview";
import { JobLog } from "./JobLog";
import { BudgetEditor } from "./Budget";
import { Button, ErrorNote, Tag } from "./ui";
import { useAgentName } from "../lib/agent";

interface Change {
  path: string;
  index: string;
  work: string;
}

function Changes({ root, sessionId }: { root: string; sessionId?: string }) {
  const agent = useAgentName();
  const [reviewing, setReviewing] = useState(false);
  const q = useQuery({ queryKey: ["changes", root], queryFn: () => api.get<Change[]>(`/code/fs/changes${qs({ root })}`), retry: false, refetchInterval: 8000 });
  if (q.error) return null;
  const list = q.data ?? [];
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-[13px] flex-1">Uncommitted changes {list.length ? <span className="text-faint font-normal">{list.length}</span> : null}</h3>
        {list.length > 0 && (
          <Button size="sm" onClick={() => setReviewing(true)} title={`Read the diff and leave notes for ${agent} on specific lines`}>
            Review the diff
          </Button>
        )}
        <Link to="/code" search={{ root }} className="text-[12px] text-cobalt hover:underline">
          Open in Code
        </Link>
      </div>
      {reviewing && <DiffReview root={root} sessionId={sessionId} onClose={() => setReviewing(false)} />}
      {list.length ? (
        <div className="rounded-md border border-line divide-y divide-line max-h-56 overflow-y-auto">
          {list.map((c) => (
            <Link key={c.path} to="/code" search={{ root, file: c.path, diff: true }} className="flex items-center gap-2 px-2.5 h-7 text-[12.5px] hover:bg-ground">
              <span className="truncate flex-1">{c.path}</span>
              <span className="font-mono text-[11px] text-amber">{(c.index + c.work).trim().replace("??", "U")}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-muted">{q.isLoading ? "Reading git" : "Nothing uncommitted."}</div>
      )}
    </section>
  );
}

function Autopilot({ c }: { c: BoardCard }) {
  const qc = useQueryClient();
  const a = c.autopilot;
  const on = !!a?.on;
  const toggle = async () => {
    await api.post("/autopilot", { worktree: c.path, on: !on });
    await qc.invalidateQueries({ queryKey: ["board"] });
  };
  return (
    <section className="space-y-1">
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-[13px] flex-1">Autopilot</h3>
        <Button size="sm" variant={on ? "default" : "primary"} onClick={toggle}>
          {on ? "Turn off" : "Turn on"}
        </Button>
      </div>
      <p className="text-[12px] text-muted">
        {on
          ? a?.gaveUp
            ? `Gave up: ${a.note ?? "still red after its tries"}. Turn it off and on to try again.`
            : (a?.note ?? "Watching the PR. Failing checks and requested changes go straight to its session.")
          : "When its PR's checks fail or a reviewer asks for changes, send them to its session on its own."}
        {on && a?.attempts ? ` Tries so far: ${a.attempts}.` : ""}
      </p>
    </section>
  );
}

// the teammate's PR this work is built on, and catching up once it moves on
function Stacked({ c }: { c: BoardCard }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const st = c.stacked!;
  const go = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      await api.post("/stacked/catch-up", { worktree: c.path });
      await qc.invalidateQueries({ queryKey: ["board"] });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const due = st.state === "moved" || st.state === "merged";
  const plain: Record<typeof st.state, string> = {
    open: "In step with it. Cockpit checks it every few minutes.",
    moved: "They pushed since. Catching up rebases your commits onto theirs and pushes with --force-with-lease if it was pushed.",
    merged: `It merged into ${st.target ?? "its base"}. Catching up moves your commits onto ${st.target ?? "it"} and points your PR there.`,
    closed: "It was closed without merging. Your work still sits on its commits.",
    gone: `Moved onto ${st.target ?? "the base"}. Nothing left to follow.`,
  };
  return (
    <section className="space-y-1">
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-[13px] flex-1 min-w-0 truncate">
          Built on{" "}
          <a href={st.url} target="_blank" rel="noreferrer" className="hover:text-cobalt">
            #{st.pr}
          </a>
          {st.author && <span className="font-normal text-muted"> by {st.author}</span>}
        </h3>
        {due && (
          <Button size="sm" variant="primary" disabled={busy} onClick={go}>
            {busy ? "Handing over" : "Catch up"}
          </Button>
        )}
      </div>
      <p className="text-[12px] text-muted">
        {st.note && st.state !== "open" ? `${st.note}. ` : ""}
        {plain[st.state]}
        {st.note && st.state === "open" ? ` Last: ${st.note}.` : ""}
      </p>
      <ErrorNote error={err} />
    </section>
  );
}

interface CiCompare {
  pr: number;
  check: string;
  ciLink?: string;
  ciTail: string;
  ciSha?: string;
  command: string;
  localSha?: string;
  localDirty: boolean;
  env: string[];
  state: "running" | "done";
  code?: number;
  localTail?: string;
  runId?: string;
  jobId?: string;
  at: number;
  verdict?: "passes-here" | "fails-both";
}

// A failing CI check, run here too, with both ends side by side
function CiHere({ c }: { c: BoardCard }) {
  const agent = useAgentName();
  const qc = useQueryClient();
  const jobs = useJobs();
  const [err, setErr] = useState<unknown>();
  const key = ["ci-compare", c.path];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<CiCompare | null>(`/ci/compare${qs({ worktree: c.path })}`), refetchInterval: (x) => (x.state.data?.state === "running" ? 3000 : false) });
  const r = q.data;
  const job = r?.jobId ? jobs.data?.find((j) => j.id === r.jobId) : undefined;
  const go = async (path: string) => {
    setErr(undefined);
    try {
      await api.post(path, { worktree: c.path });
      await Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ["jobs"] })]);
    } catch (e) {
      setErr(e);
    }
  };
  const short = (sha?: string) => sha?.slice(0, 7) ?? "?";
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-[13px] flex-1 min-w-0">
          CI against here
          {r && (
            <span className={`font-normal ${r.state === "running" ? "text-cobalt" : r.verdict === "passes-here" ? "text-amber" : "text-red"}`}>
              {" "}
              · {r.check}: {r.state === "running" ? "running here" : r.verdict === "passes-here" ? "passes here, fails in CI" : "fails here too"} · {ago(r.at)}
            </span>
          )}
        </h3>
        {r?.verdict === "passes-here" && c.session && c.session.status !== "ended" && (
          <Button size="sm" onClick={() => go("/ci/compare/send")}>
            Ask {agent} why
          </Button>
        )}
        <Button size="sm" disabled={r?.state === "running"} onClick={() => go("/ci/compare")} title="Run the failing check's job in this worktree and compare">
          {r?.state === "running" ? "Running" : r ? "Run again" : "Run it here"}
        </Button>
      </div>
      {!r && <p className="text-[12px] text-muted">A check fails on the PR. Run the same job here to see whether it's the code or CI's setup.</p>}
      {r && (
        <>
          <p className="text-[12px] text-muted">
            CI ran {short(r.ciSha)}, here is {short(r.localSha)}
            {r.localDirty ? " with uncommitted changes" : ""}
            {r.ciSha && r.localSha && r.ciSha !== r.localSha ? ", so the code differs too" : ""}. Here: <span className="font-mono">{r.command}</span>
          </p>
          <div className="grid md:grid-cols-2 gap-2">
            <div className="min-w-0">
              <div className="text-[12px] text-faint mb-0.5">
                In CI{" "}
                {r.ciLink && (
                  <a href={r.ciLink} target="_blank" rel="noreferrer" className="hover:text-cobalt">
                    (log)
                  </a>
                )}
              </div>
              <pre className="max-h-56 overflow-auto rounded-md bg-ground px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">{r.ciTail.trim() || "No log came back"}</pre>
            </div>
            <div className="min-w-0">
              <div className="text-[12px] text-faint mb-0.5">
                Here{" "}
                {r.runId && (
                  <Link to="/runs/$id" params={{ id: r.runId }} className="hover:text-cobalt">
                    (run)
                  </Link>
                )}
              </div>
              {job && r.state === "running" ? <JobLog job={job} /> : <pre className="max-h-56 overflow-auto rounded-md bg-ground px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">{r.localTail?.trim() || "No output"}</pre>}
            </div>
          </div>
          {r.verdict === "passes-here" && <p className="text-[12px] text-faint">This machine: {r.env.join(" · ")}</p>}
        </>
      )}
      <ErrorNote error={err} />
    </section>
  );
}

function Verify({ c }: { c: BoardCard }) {
  const agent = useAgentName();
  const qc = useQueryClient();
  const cfg = useAppConfig();
  const jobs = useJobs();
  const [err, setErr] = useState<unknown>();
  const v = c.verify;
  const job = v?.jobId ? jobs.data?.find((j) => j.id === v.jobId) : undefined;
  if (!cfg.data?.verify) return null;
  const go = async (path: string) => {
    setErr(undefined);
    try {
      await api.post(path, { worktree: c.path });
      await Promise.all([qc.invalidateQueries({ queryKey: ["board"] }), qc.invalidateQueries({ queryKey: ["jobs"] })]);
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-[13px] flex-1">
          Checks here {v && <span className={`font-normal ${v.state === "pass" ? "text-green" : v.state === "fail" ? "text-red" : "text-cobalt"}`}>· {v.state === "running" ? "running" : v.state === "pass" ? "passing" : "failing"} · {ago(v.at)}</span>}
        </h3>
        {v?.state === "fail" && c.session && c.session.status !== "ended" && (
          <Button size="sm" onClick={() => go("/verify/send")}>
            Send the failure to {agent}
          </Button>
        )}
        <Button size="sm" disabled={v?.state === "running"} onClick={() => go("/verify")}>
          {v?.state === "running" ? "Running" : "Run now"}
        </Button>
      </div>
      {job && v?.state === "running" ? <JobLog job={job} /> : v?.summary && v.state === "fail" ? <pre className="max-h-48 overflow-auto rounded-md bg-ground px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap">{v.summary}</pre> : null}
      {!v && <p className="text-[12px] text-muted">Runs the repo's checks when its session finishes a turn.</p>}
      <ErrorNote error={err} />
    </section>
  );
}

// node: the machine the worktree is on, whose address the dev server answers at
function Preview({ root, node }: { root: string; node?: string }) {
  const qc = useQueryClient();
  const cfg = useAppConfig();
  const machines = useQuery({ queryKey: ["machines"], queryFn: () => api.get<{ machines: Machine[] }>("/machines"), enabled: !!node });
  const nodeUrl = machines.data?.machines.find((m) => m.id === node)?.url;
  const host = node && nodeUrl ? new URL(nodeUrl.replace(/^ws/, "http")).hostname : location.hostname;
  const [err, setErr] = useState<unknown>();
  const q = useQuery({ queryKey: ["preview", root], queryFn: () => api.get<{ port: number; term: string; running: boolean } | null>(`/preview${qs({ worktree: root })}`), enabled: !!cfg.data?.preview, refetchInterval: 10_000 });
  if (!cfg.data?.preview) return null;
  const p = q.data;
  const url = p ? `${node ? "http:" : location.protocol}//${host}:${p.port}` : "";
  const go = async (stop = false) => {
    setErr(undefined);
    try {
      await api.post("/preview", { worktree: root, stop });
      await qc.invalidateQueries({ queryKey: ["preview", root] });
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-[13px] flex-1">Preview {p?.running && <span className="text-faint font-normal">· port {p.port}</span>}</h3>
        {p?.running && (
          <>
            <a href={url} target="_blank" rel="noreferrer" className="text-[12px] text-cobalt hover:underline">
              Open
            </a>
            <Link to="/terminals" search={{ id: p.term }} className="text-[12px] text-cobalt hover:underline">
              Logs
            </Link>
          </>
        )}
        <Button size="sm" onClick={() => go(!!p?.running)}>
          {p?.running ? "Stop" : "Start preview"}
        </Button>
      </div>
      {p?.running ? (
        <>
          <iframe src={url} title="Preview" className="w-full h-[360px] rounded-md border border-line bg-white" />
          <p className="text-[11.5px] text-faint">Embedded straight from port {p.port}, so it only shows where that port is reachable from this device.</p>
        </>
      ) : (
        <p className="text-[12px] text-muted">Runs the repo's dev command in this worktree on a free port.</p>
      )}
      <ErrorNote error={err} />
    </section>
  );
}

// Everything about one card, with the actions that move it along.
const REVIEW: Record<Reviewer["state"], { tone: "plain" | "green" | "amber" | "red"; text: string }> = {
  REQUESTED: { tone: "plain", text: "asked" },
  PENDING: { tone: "plain", text: "asked" },
  APPROVED: { tone: "green", text: "approved" },
  CHANGES_REQUESTED: { tone: "red", text: "wants changes" },
  COMMENTED: { tone: "amber", text: "commented" },
  DISMISSED: { tone: "plain", text: "dismissed" },
};

// Who was asked to review, from the code host and any review source, and a way to ask again on the code host
function Reviewers({ n, list }: { n: number; list: Reviewer[] }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const again = list.filter((r) => r.login && ["CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(r.state)).map((r) => r.login!);
  if (!list.length) return <p className="text-[12px] text-faint">Nobody is asked to review it yet.</p>;
  const ask = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.post(`/prs/${n}/rerequest`, { logins: again });
      await qc.invalidateQueries({ queryKey: ["board"] });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
        <span className="text-muted">Reviewers</span>
        {list.map((r) => (
          <Tag key={`${r.source}:${r.name}`} tone={REVIEW[r.state]?.tone ?? "plain"} title={r.source ? `From ${r.source}` : undefined}>
            {r.name} · {REVIEW[r.state]?.text ?? r.state.toLowerCase()}
          </Tag>
        ))}
        {again.length > 0 && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={ask} title={`Asks ${again.join(", ")} to review again on the code host`}>
            {busy ? "Asking" : "Ask again"}
          </Button>
        )}
      </div>
      <ErrorNote error={err} />
    </div>
  );
}

export function BoardCardDetail({ c, onClose }: { c: BoardCard; onClose: () => void }) {
  const qc = useQueryClient();
  const openSession = useOpenSession();
  const s = c.session;
  const pr = asPr(c);
  const live = !!s && s.status !== "ended";
  const archive = async () => {
    // node: the card came from that machine's board, which is where it's archived
    await api.post("/board/archive", { id: c.id, node: c.node });
    await qc.invalidateQueries({ queryKey: ["board"] });
    onClose();
  };

  return (
    <div className="p-5 space-y-5">
      <header className="space-y-1">
        <div className="flex items-start gap-3">
          <h2 className="text-[17px] font-semibold leading-snug flex-1">{c.title}</h2>
          <button onClick={onClose} className="size-7 rounded text-faint hover:text-ink hover:bg-ground shrink-0" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
          {c.ticket && <span className="rounded bg-ground px-1 font-mono text-[11.5px] text-ink">{c.ticket}</span>}
          <span>{c.folder}</span>
          {c.branch && <span className="font-mono text-[11.5px] text-faint">{c.branch}</span>}
        </div>
        <div className={`text-[13px] ${c.column === "needs" ? "text-amber" : "text-muted"}`}>{c.stuck ? `Looks stuck: ${c.stuck}` : c.reason}</div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {s && (
          <Link to="/sessions/$id" params={{ id: s.id }}>
            <Button size="sm">Transcript</Button>
          </Link>
        )}
        {s && (
          <Button size="sm" onClick={() => openSession(s)}>
            {live ? "Open its terminal" : "Resume in a terminal"}
          </Button>
        )}
        {c.task && (
          <Link to="/tasks/$group" params={{ group: c.task.group }}>
            <Button size="sm">{c.task.attempt > 1 ? "Compare attempts" : "Task"}</Button>
          </Link>
        )}
        {c.path && (
          <Link to="/code" search={{ root: c.path }}>
            <Button size="sm">Code</Button>
          </Link>
        )}
        {(c.column === "ready" || c.column === "quiet") && (
          <Button size="sm" variant="ghost" onClick={archive} title="Take it off the board">
            Archive
          </Button>
        )}
      </div>

      {live && (
        <section className="space-y-1.5">
          <h3 className="font-medium text-[13px]">
            {statusLook(s.status, s.waitingFor, s.background).hint} <span className="text-faint font-normal">· {ago(s.updatedAt)}</span>
          </h3>
          <ReplyPanel session={s} />
        </section>
      )}

      {pr && (
        <section className="space-y-1.5">
          <h3 className="font-medium text-[13px]">Pull request</h3>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <PrBadge pr={pr} />
            <span className="truncate flex-1 min-w-0">{pr.title}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {c.pr?.mergeState && <Tag>{c.pr.mergeState.toLowerCase()}</Tag>}
            <PrFix pr={pr} />
          </div>
          {c.pr?.state === "OPEN" && <Reviewers n={c.pr.number} list={c.pr.reviewers ?? []} />}
        </section>
      )}

      {c.ticket && <BudgetEditor ticket={c.ticket} spend={c.spend} />}
      {c.kind === "worktree" && c.path && c.stacked && <Stacked c={c} />}
      {c.kind === "worktree" && c.path && c.pr?.state === "OPEN" && c.pr.checks === "fail" && <CiHere c={c} />}
      {c.kind === "worktree" && c.path && <Verify c={c} />}
      {c.kind === "worktree" && c.path && c.pr && <Autopilot c={c} />}
      {c.kind === "worktree" && c.path && <Preview root={c.path} node={c.node} />}
      {c.path && c.kind === "worktree" && <Changes root={c.path} sessionId={live ? s?.id : undefined} />}
      {c.path && c.kind !== "worktree" && <div className="text-[12px] text-faint">{shortPath(c.path)}</div>}
    </div>
  );
}
