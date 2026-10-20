import { existsSync } from "node:fs";
import { listSessions, sessionFile } from "./claude/sessions.ts";
import { parseLine, readTail } from "./claude/transcript.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { deletePending, parsePr, pendingReview, prInfo } from "./providers.ts";
import { listTerms, spawnTerm } from "./pty.ts";

db.exec(`
  create table if not exists reviews (
    id integer primary key autoincrement,
    repo text not null,
    pr integer not null,
    url text not null,
    title text,
    author text,
    started_at integer not null,
    term_id text,
    pid integer,
    session_id text,
    status text not null default 'running',
    review_url text,
    verdict text,
    comments integer
  );
`);

export interface ReviewRow {
  id: number;
  repo: string;
  pr: number;
  url: string;
  title: string | null;
  author: string | null;
  started_at: number;
  term_id: string | null;
  pid: number | null;
  session_id: string | null;
  status: string;
  review_url: string | null;
  verdict: string | null;
  comments: number | null;
}

// the code host plugin does the talking: reading the PR and the pending review
export { parsePr, pendingReview, prInfo } from "./providers.ts";

export async function startReview(opts: { input: string; backend?: boolean; existing?: "add" | "replace" }) {
  const pr = parsePr(opts.input);
  if (!pr) throw new Error("paste a pull request link or number");
  const info = await prInfo(pr);

  if (opts.existing === "replace") {
    const pending = await pendingReview(pr);
    if (pending) await deletePending(pr, pending.id);
  }

  const cfg = config.reviews;
  let prompt = cfg.command.replace("{url}", info.url);
  if (opts.backend) prompt += cfg.backendNote;
  // the review skill would stop to ask about an existing pending review, so answer it up front
  if (opts.existing === "add") prompt += " I already have a pending review on this PR, add your comments to it.";

  const cwd = cfg.cwd || config.repo.path;
  if (!existsSync(cwd)) throw new Error(`review folder not found: ${cwd}`);
  const term = spawnTerm({ cwd, command: "claude", args: [prompt], title: `review #${pr.n}` });

  const res = db
    .prepare("insert into reviews (repo, pr, url, title, author, started_at, term_id, pid) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(pr.repo, pr.n, info.url, info.title, info.author, Date.now(), term.id, term.pid);
  return { id: Number(res.lastInsertRowid), termId: term.id };
}

const REVIEW_URL = /https:\/\/github\.com\/[^\s)\]"'<>]+\/pull\/\d+#pullrequestreview-\d+/g;
const VERDICT = /\b(Changes requested|Approved with comments|Approved)\b/;

// The skill ends with a link to the pending review and a verdict line; take the latest of each.
export function readOutcome(texts: string[]) {
  let reviewUrl: string | undefined;
  let verdict: string | undefined;
  for (let i = texts.length - 1; i >= 0 && !(reviewUrl && verdict); i--) {
    reviewUrl ??= texts[i].match(REVIEW_URL)?.at(-1);
    verdict ??= texts[i].match(VERDICT)?.[1];
  }
  return { reviewUrl, verdict };
}

const update = db.prepare("update reviews set session_id = @session_id, status = @status, review_url = @review_url, verdict = @verdict, comments = @comments where id = @id");

async function refresh(r: ReviewRow): Promise<ReviewRow> {
  if (r.status === "done" || r.status === "stopped") return r;

  const term = listTerms().find((t) => t.id === r.term_id);
  const live = listSessions({ liveOnly: true });
  const session = (r.session_id && live.find((s) => s.id === r.session_id)) || live.find((s) => !!r.pid && s.pid === r.pid);
  const next = { ...r, session_id: session?.id ?? r.session_id };

  const file = next.session_id ? sessionFile(next.session_id) : undefined;
  if (file) {
    const tail = await readTail(file, 512 * 1024).catch(() => undefined);
    const texts = (tail?.lines ?? []).flatMap((l) => parseLine(l)).flatMap((e) => (e.kind === "assistant" ? [e.text] : []));
    const out = readOutcome(texts);
    next.review_url = out.reviewUrl ?? next.review_url;
    next.verdict = out.verdict ?? next.verdict;
  }

  const ended = !term || term.exited !== undefined;
  if (next.verdict && (ended || session?.status === "idle")) {
    next.status = "done";
    const pending = await pendingReview({ repo: r.repo, n: r.pr }).catch(() => undefined);
    if (pending) {
      next.review_url = pending.url;
      next.comments = pending.comments;
    }
  } else if (ended) next.status = "stopped";
  else next.status = session?.status === "idle" ? "waiting" : "running";

  update.run(next);
  return next;
}

export async function listReviews() {
  const rows = db.prepare<[], ReviewRow>("select * from reviews order by started_at desc limit 50").all();
  return Promise.all(rows.map(refresh));
}

export async function getReview(id: number) {
  const r = db.prepare<[number], ReviewRow>("select * from reviews where id = ?").get(id);
  return r ? refresh(r) : undefined;
}

// Bring a review's terminal back. A closed one resumes the same Claude session, so it carries on with its context.
export async function reopenReview(id: number) {
  const r = db.prepare<[number], ReviewRow>("select * from reviews where id = ?").get(id);
  if (!r) throw new Error("review not found");
  const term = listTerms().find((t) => t.id === r.term_id);
  if (term && term.exited === undefined) return { id, termId: term.id };
  if (!r.session_id) throw new Error("No Claude session was recorded for this review, so start it again from the PR.");

  const cwd = config.reviews.cwd || config.repo.path;
  const next = spawnTerm({ cwd, command: "claude", args: ["--resume", r.session_id], title: `review #${r.pr}`, session: r.session_id });
  db.prepare("update reviews set term_id = ?, pid = ?, status = 'running' where id = ?").run(next.id, next.pid ?? null, id);
  return { id, termId: next.id };
}
