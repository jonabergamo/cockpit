import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { LastReview } from "@cockpit/shared";
import { useEffect, useState } from "react";
import { newTask } from "../components/NewTask";
import { RefreshButton, useRefreshing } from "../components/RefreshButton";
import { Terminal } from "../components/Terminal";
import { Button, Empty, ErrorNote, inputClass, Loading, PageHeader, Tag } from "../components/ui";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useAppConfig, usePrs } from "../lib/queries";
import { useTerms } from "./Terminals";
import { useAgentName } from "../lib/agent";

interface Review {
  id: number;
  repo: string;
  pr: number;
  url: string;
  title: string | null;
  author: string | null;
  started_at: number;
  term_id: string | null;
  status: "running" | "waiting" | "done" | "stopped";
  review_url: string | null;
  verdict: string | null;
  comments: number | null;
}

interface Check {
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  state: string;
  pending: { id: number; url: string; comments: number } | null;
}

const statusTag = (r: Review) => {
  if (r.status === "done") {
    const v = r.verdict ?? "done";
    return <Tag tone={/changes/i.test(v) ? "red" : /comments/i.test(v) ? "amber" : "green"}>{v}</Tag>;
  }
  if (r.status === "waiting") return <Tag tone="amber">needs you</Tag>;
  if (r.status === "stopped") return <Tag tone="faint">stopped</Tag>;
  return <Tag tone="cobalt">reviewing</Tag>;
};

export function ReviewsPage() {
  const agent = useAgentName();
  const { id, pr } = useSearch({ from: "/reviews" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const reviews = useQuery({
    queryKey: ["reviews"],
    queryFn: () => api.get<Review[]>("/reviews"),
    // only while one is going; finished reviews don't change
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "running" || r.status === "waiting") ? 4000 : false),
  });
  const prs = usePrs();
  const refreshing = useRefreshing(["prs"], ["reviews"]);
  const [input, setInput] = useState("");
  const [backend, setBackend] = useState(false);
  const cfg = useAppConfig();
  const [check, setCheck] = useState<Check & { again?: boolean }>();

  const start = useMutation({
    mutationFn: (b: { input: string; existing?: "add" | "replace"; again?: boolean }) => api.post<{ id: number }>("/reviews", { ...b, backend }),
    onSuccess: (r) => {
      setCheck(undefined);
      setInput("");
      qc.invalidateQueries({ queryKey: ["reviews"] });
      qc.invalidateQueries({ queryKey: ["terms"] });
      navigate({ to: "/reviews", search: { id: r.id } });
    },
  });

  // look first: an existing draft review of mine changes what the skill should do with it
  const look = useMutation({
    mutationFn: (v: { value: string; again?: boolean }) => api.post<Check>("/reviews/check", { input: v.value }).then((c) => ({ ...c, again: v.again })),
    onSuccess: (c, v) => (c.pending ? setCheck(c) : start.mutate({ input: v.value, again: v.again })),
  });

  // again: a second look at only what changed since your last review
  const go = (value: string, again?: boolean) => {
    if (!value.trim()) return;
    setCheck(undefined);
    look.mutate({ value: value.trim(), again });
  };

  // /reviews?pr=<link> comes from the Today page's review requests
  useEffect(() => {
    if (!pr) return;
    setInput(pr);
    go(pr);
    navigate({ to: "/reviews", search: {}, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr]);

  // a PR you already reviewed comes back when it's asked for again, with a second look offered
  const queue = prs.data?.review ?? [];
  const selected = reviews.data?.find((r) => r.id === id) ?? (id ? undefined : reviews.data?.[0]);
  const busy = look.isPending || start.isPending;

  return (
    <div className="grid lg:grid-cols-[360px_1fr] gap-5 max-w-[1500px]">
      <div className="space-y-5 min-w-0">
        <PageHeader title="PR reviews" sub={`Paste a pull request. ${agent} reviews it and leaves a draft review for you to submit.`}>
          <RefreshButton targets={[{ key: ["prs"], url: "/prs" }, { key: ["reviews"] }]} />
        </PageHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go(input);
          }}
          className="bg-panel border border-line rounded-lg p-3 space-y-2.5"
        >
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (/\/pull\/\d+/.test(text)) {
                e.preventDefault();
                setInput(text);
                go(text);
              }
            }}
            placeholder="Paste a PR link, or type its number"
            className={`${inputClass} w-full`}
          />
          <div className="flex items-center gap-3">
            {/* only when the review command says what to add for it, in config's reviews.backendNote */}
            {cfg.data?.reviewBackend ? (
              <label className="flex items-center gap-1.5 text-[13px] text-muted flex-1">
                <input type="checkbox" checked={backend} onChange={(e) => setBackend(e.target.checked)} />
                Include the backend
              </label>
            ) : (
              <span className="flex-1" />
            )}
            <Button variant="primary" disabled={!input.trim() || busy}>
              {look.isPending ? "Checking" : start.isPending ? "Starting" : "Review"}
            </Button>
          </div>
          <p className="text-[12px] text-faint">Pasting a link starts it straight away.</p>
          <ErrorNote error={look.error ?? start.error} />
          {check?.pending && (
            <div className="border border-amber/50 bg-amber-soft/40 rounded-md p-2.5 text-[13px] space-y-2">
              <div>
                You already have a draft review on #{check.number} with {check.pending.comments} comments.
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" onClick={() => start.mutate({ input: check.url, existing: "add", again: check.again })}>
                  Add to it
                </Button>
                <Button size="sm" variant="danger" onClick={() => start.mutate({ input: check.url, existing: "replace", again: check.again })}>
                  Replace it
                </Button>
                <a href={check.pending.url} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="ghost" type="button">
                    Open it
                  </Button>
                </a>
              </div>
            </div>
          )}
        </form>

        <section className={`bg-panel border border-line rounded-lg ${refreshing ? "wave" : ""}`}>
          <h2 className="font-semibold px-3 pt-2.5 pb-1.5">Waiting for your review</h2>
          {prs.isLoading && <Loading what="Asking for review requests" />}
          {prs.error && (
            <div className="px-3 pb-2">
              <ErrorNote error={prs.error} />
            </div>
          )}
          <div className="divide-y divide-line">
            {queue.map((p) => (
              <div key={p.number} className="flex items-center gap-2 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <a href={p.url} target="_blank" rel="noreferrer" className="block truncate text-[13px] hover:text-cobalt" title={p.title}>
                    #{p.number} {p.title}
                  </a>
                  <div className="text-[12px] text-muted">
                    {p.author} · {ago(p.createdAt)}
                  </div>
                  <SinceYourReview url={p.url} busy={busy} onAgain={() => go(p.url, true)} />
                </div>
                <Button size="sm" variant="ghost" title="Start a task whose work is built on this PR's branch" onClick={() => newTask.open({ onPr: p.url })}>
                  Build on it
                </Button>
                <Button size="sm" disabled={busy} onClick={() => go(p.url)}>
                  Review
                </Button>
              </div>
            ))}
            {prs.data && !queue.length && <div className="px-3 py-2.5 text-[13px] text-muted">Nobody is waiting on you.</div>}
          </div>
        </section>

        <section className={`bg-panel border border-line rounded-lg ${refreshing ? "wave" : ""}`}>
          <h2 className="font-semibold px-3 pt-2.5 pb-1.5">Reviews</h2>
          {reviews.isLoading && <Loading />}
          {reviews.error && (
            <div className="px-3 pb-2">
              <ErrorNote error={reviews.error} />
            </div>
          )}
          <div className="divide-y divide-line">
            {reviews.data?.map((r) => (
              <div key={r.id} className={`flex items-center gap-2 px-3 py-2 ${selected?.id === r.id ? "bg-cobalt-soft/60" : "hover:bg-ground"}`}>
                <button onClick={() => navigate({ to: "/reviews", search: { id: r.id } })} className="flex-1 min-w-0 text-left">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] flex-1">
                      #{r.pr} {r.title}
                    </span>
                    {statusTag(r)}
                  </div>
                  <div className="text-[12px] text-muted">
                    {r.author} · {ago(r.started_at)}
                  </div>
                </button>
                <ReopenButton review={r} />
              </div>
            ))}
            {reviews.data && !reviews.data.length && <div className="px-3 py-2.5 text-[13px] text-muted">No reviews yet.</div>}
          </div>
        </section>
      </div>

      <div className="min-w-0">{selected ? <ReviewDetail review={selected} /> : <Empty>Paste a PR to start a review.</Empty>}</div>
    </div>
  );
}

function useLastReview(url: string) {
  return useQuery({ queryKey: ["last-review", url], queryFn: () => api.get<LastReview | null>(`/reviews/last?${new URLSearchParams({ pr: url })}`), staleTime: 60_000, retry: false });
}

// what changed since your last submitted review of a PR, with the second look that covers only that
function SinceYourReview({ url, busy, onAgain }: { url: string; busy: boolean; onAgain: () => void }) {
  const last = useLastReview(url).data;
  if (!last) return null;
  const changed = last.rewritten ? "rewritten since" : last.commits ? `${last.commits} new commit${last.commits === 1 ? "" : "s"}, ${last.files} file${last.files === 1 ? "" : "s"}` : "nothing new";
  return (
    <div className="flex items-center gap-2 mt-1 text-[12px]">
      <a href={last.url} target="_blank" rel="noreferrer" className="text-muted hover:text-cobalt" title={`Your review of ${last.commit.slice(0, 7)}, ${last.comments.length} comments`}>
        You reviewed it {ago(last.at)} · {changed}
      </a>
      {(last.commits > 0 || last.rewritten) && (
        <Button size="sm" variant="primary" disabled={busy} onClick={onAgain} title="Review only what changed since, and check each of your earlier comments">
          Review what changed
        </Button>
      )}
    </div>
  );
}

// Open terminals just get selected; closed ones resume the review's session (Claude Code or Codex) in a new terminal.
function ReopenButton({ review: r, label }: { review: Review; label?: string }) {
  const terms = useTerms();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const open = terms.data?.some((t) => t.id === r.term_id && t.exited === undefined);
  const reopen = useMutation({
    mutationFn: () => api.post<{ id: number; termId: string }>(`/reviews/${r.id}/reopen`),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["terms"] }), qc.invalidateQueries({ queryKey: ["reviews"] })]);
      navigate({ to: "/reviews", search: { id: r.id } });
    },
  });
  return (
    <span className="shrink-0">
      <Button
        size="sm"
        variant={label ? "primary" : "ghost"}
        disabled={reopen.isPending}
        title={open ? "Show its terminal" : "Resume its session in a new terminal"}
        onClick={() => (open ? navigate({ to: "/reviews", search: { id: r.id } }) : reopen.mutate())}
      >
        {reopen.isPending ? "Opening" : (label ?? (open ? "Terminal" : "Reopen"))}
      </Button>
      {label ? <ErrorNote error={reopen.error} /> : reopen.error ? <span className="block max-w-[200px] text-right text-[12px] text-red">{(reopen.error as Error).message}</span> : null}
    </span>
  );
}

function ReviewDetail({ review: r }: { review: Review }) {
  const agent = useAgentName();
  const terms = useTerms();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const term = terms.data?.find((t) => t.id === r.term_id);
  const again = useMutation({
    mutationFn: () => api.post<{ id: number }>("/reviews", { input: r.url, again: true }),
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ["reviews"] });
      qc.invalidateQueries({ queryKey: ["terms"] });
      navigate({ to: "/reviews", search: { id: n.id } });
    },
  });

  return (
    <div className="space-y-4">
      <div className="bg-panel border border-line rounded-lg p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-muted">
              {r.repo} #{r.pr} · {r.author}
            </div>
            <h2 className="text-[19px] font-semibold leading-snug">{r.title}</h2>
          </div>
          {statusTag(r)}
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <a href={r.url} target="_blank" rel="noreferrer">
            <Button size="sm">Open the PR</Button>
          </a>
          {r.review_url && (
            <a href={r.review_url} target="_blank" rel="noreferrer">
              <Button size="sm" variant="primary">
                Open draft review{r.comments ? ` (${r.comments} comments)` : ""}
              </Button>
            </a>
          )}
        </div>
        {r.status === "done" && (
          <p className="text-[13px] text-muted mt-3">
            {r.review_url ? "The review is a draft on GitHub. Read it there and submit it when you're happy." : `Nothing was posted. ${agent} found nothing worth a comment.`}
          </p>
        )}
        {r.status === "waiting" && <p className="text-[13px] text-amber mt-3">{agent} stopped and is waiting for you in the terminal below.</p>}
        {(r.status === "done" || r.status === "stopped") && <SinceYourReview url={r.url} busy={again.isPending} onAgain={() => again.mutate()} />}
        <ErrorNote error={again.error} />
      </div>

      {term ? (
        <div className="h-[calc(100vh-330px)] min-h-[360px] border border-line rounded-lg overflow-hidden">
          <Terminal key={term.id} id={term.id} onExit={() => (qc.invalidateQueries({ queryKey: ["terms"] }), qc.invalidateQueries({ queryKey: ["reviews"] }))} />
        </div>
      ) : (
        <Empty>
          <div className="space-y-2">
            <div>The terminal for this review is closed.</div>
            <ReopenButton review={r} label="Reopen it and carry on" />
          </div>
        </Empty>
      )}
    </div>
  );
}
