import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RefreshButton } from "../components/RefreshButton";
import { Terminal } from "../components/Terminal";
import { Button, Empty, ErrorNote, inputClass, PageHeader, Tag } from "../components/ui";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { usePrs } from "../lib/queries";
import { useTerms } from "./Terminals";

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
  const [input, setInput] = useState("");
  const [backend, setBackend] = useState(false);
  const [check, setCheck] = useState<Check>();

  const start = useMutation({
    mutationFn: (b: { input: string; existing?: "add" | "replace" }) => api.post<{ id: number }>("/reviews", { ...b, backend }),
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
    mutationFn: (value: string) => api.post<Check>("/reviews/check", { input: value }),
    onSuccess: (c, value) => (c.pending ? setCheck(c) : start.mutate({ input: value })),
  });

  const go = (value: string) => {
    if (!value.trim()) return;
    setCheck(undefined);
    look.mutate(value.trim());
  };

  // /reviews?pr=<link> comes from the Today page's review requests
  useEffect(() => {
    if (!pr) return;
    setInput(pr);
    go(pr);
    navigate({ to: "/reviews", search: {}, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr]);

  const reviewed = new Set(reviews.data?.map((r) => r.url));
  const queue = (prs.data?.review ?? []).filter((p) => !reviewed.has(p.url));
  const selected = reviews.data?.find((r) => r.id === id) ?? (id ? undefined : reviews.data?.[0]);
  const busy = look.isPending || start.isPending;

  return (
    <div className="grid lg:grid-cols-[360px_1fr] gap-5 max-w-[1500px]">
      <div className="space-y-5 min-w-0">
        <PageHeader title="PR reviews" sub="Paste a pull request. Claude reviews it and leaves a draft review for you to submit.">
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
            <label className="flex items-center gap-1.5 text-[13px] text-muted flex-1">
              <input type="checkbox" checked={backend} onChange={(e) => setBackend(e.target.checked)} />
              Include the backend
            </label>
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
                <Button size="sm" onClick={() => start.mutate({ input: check.url, existing: "add" })}>
                  Add to it
                </Button>
                <Button size="sm" variant="danger" onClick={() => start.mutate({ input: check.url, existing: "replace" })}>
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

        <section className="bg-panel border border-line rounded-lg">
          <h2 className="font-semibold px-3 pt-2.5 pb-1.5">Waiting for your review</h2>
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
                </div>
                <Button size="sm" disabled={busy} onClick={() => go(p.url)}>
                  Review
                </Button>
              </div>
            ))}
            {!queue.length && <div className="px-3 py-2.5 text-[13px] text-muted">Nobody is waiting on you.</div>}
          </div>
        </section>

        <section className="bg-panel border border-line rounded-lg">
          <h2 className="font-semibold px-3 pt-2.5 pb-1.5">Reviews</h2>
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
            {!reviews.data?.length && <div className="px-3 py-2.5 text-[13px] text-muted">No reviews yet.</div>}
          </div>
        </section>
      </div>

      <div className="min-w-0">{selected ? <ReviewDetail review={selected} /> : <Empty>Paste a PR to start a review.</Empty>}</div>
    </div>
  );
}

// Open terminals just get selected; closed ones resume the review's Claude session in a new terminal.
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
        title={reopen.error ? String((reopen.error as Error).message) : open ? "Show its terminal" : "Resume its Claude session in a new terminal"}
        onClick={() => (open ? navigate({ to: "/reviews", search: { id: r.id } }) : reopen.mutate())}
      >
        {reopen.isPending ? "Opening" : (label ?? (open ? "Terminal" : "Reopen"))}
      </Button>
      {label && <ErrorNote error={reopen.error} />}
    </span>
  );
}

function ReviewDetail({ review: r }: { review: Review }) {
  const terms = useTerms();
  const qc = useQueryClient();
  const term = terms.data?.find((t) => t.id === r.term_id);

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
            {r.review_url ? "The review is a draft on GitHub. Read it there and submit it when you're happy." : "Nothing was posted. Claude found nothing worth a comment."}
          </p>
        )}
        {r.status === "waiting" && <p className="text-[13px] text-amber mt-3">Claude stopped and is waiting for you in the terminal below.</p>}
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
