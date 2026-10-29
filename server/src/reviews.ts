import { existsSync } from "node:fs";
import type { LastReview } from "@cockpit/shared";
import { canSend, sendText } from "./agents.ts";
import { listSessions, sessionFile } from "./claude/sessions.ts";
import { parseLine, readTail } from "./claude/transcript.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { deletePending, lastReview, parsePr, pendingReview, prInfo } from "./providers.ts";
import { listTerms, spawnTerm } from "./pty.ts";
import { agentLaunch, resumeLaunch } from "./workers/index.ts";
import { codexEntries, isCodexTerminal } from "./claude/codexTerminal.ts";

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
export { lastReview, parsePr, pendingReview, prInfo } from "./providers.ts";

// A second look: only what changed since your last review, and whether each of your comments was dealt with
export function againNote(last: LastReview) {
  const short = last.commit.slice(0, 12);
  const since = last.rewritten
    ? `The branch was rewritten since then (force-pushed), so ${short} may be gone: compare the PR's diff now with what you can tell of the old one, and say so in the summary.`
    : `Only review what changed since then: \`git fetch\` and \`git diff ${short}..${last.head.slice(0, 12)}\`, or the compare view for those two commits. That's ${last.commits} commit${last.commits === 1 ? "" : "s"} touching ${last.files} file${last.files === 1 ? "" : "s"}.`;
  const comments = last.comments.length
    ? `\n\nMy earlier comments, for each one say whether it was fixed, answered or is still open, and only comment again on the ones still open:\n${last.comments.map((c, i) => `${i + 1}. ${c.path ? `${c.path}${c.line ? `:${c.line}` : ""}: ` : ""}${c.body.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}`
    : "";
  return ` This is a second look. I reviewed it at commit ${short} (${last.state.toLowerCase().replace(/_/g, " ")}, ${last.at.slice(0, 10)}). ${since}${comments}`;
}

export async function startReview(opts: { input: string; backend?: boolean; existing?: "add" | "replace"; again?: boolean }) {
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
  if (opts.again) {
    const last = await lastReview(pr);
    if (!last) throw new Error("You haven't reviewed this PR before, so there's nothing to compare with. Start a full review.");
    prompt += againNote(last);
  }
  // the review skill would stop to ask about an existing pending review, so answer it up front
  if (opts.existing === "add") prompt += " I already have a pending review on this PR, add your comments to it.";

  const cwd = cfg.cwd || config.repo.path;
  if (!existsSync(cwd)) throw new Error(`review folder not found: ${cwd}`);
  if (opts.again) {
    const prev = db.prepare<[string, number], ReviewRow>("select * from reviews where repo = ? and pr = ? and session_id is not null order by started_at desc limit 1").get(pr.repo, pr.n);
    if (prev) return againIn(prev, prompt, cwd);
  }
  const go = agentLaunch(prompt);
  const term = spawnTerm({ cwd, command: go.command, args: go.args, title: `review #${pr.n}` });

  const res = db
    .prepare("insert into reviews (repo, pr, url, title, author, started_at, term_id, pid) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(pr.repo, pr.n, info.url, info.title, info.author, Date.now(), term.id, term.pid);
  return { id: Number(res.lastInsertRowid), termId: term.id };
}

// A second look carries on in the first review's session, so it already knows the PR and what it said about it:
// told straight away when it's open and free, else resumed with the prompt
async function againIn(r: ReviewRow, prompt: string, cwd: string) {
  const session = listSessions({ liveOnly: true }).find((s) => s.id === r.session_id);
  if (session?.status === "busy") throw new Error("That review's session is busy. Try again once it finishes its turn.");
  let termId = r.term_id;
  let pid = r.pid;
  // only an idle session is told; one waiting on a question would take it as the answer
  const told = !!session && (session.agent || session.status === "idle") && canSend(session.id) && (await sendText(session.id, prompt));
  if (!told) {
    if (session) throw new Error("That review's session is still open and waiting on you. Answer it or close it, then try again.");
    const next = spawnTerm({ cwd, ...resumeLaunch(r.session_id!, prompt), title: `review #${r.pr}`, session: r.session_id! });
    termId = next.id;
    pid = next.pid ?? null;
  }
  // started_at moves on so the outcome is read from this turn on, not the first review's verdict
  db.prepare("update reviews set term_id = ?, pid = ?, started_at = ?, status = 'running', review_url = null, verdict = null, comments = null where id = ?").run(termId, pid, Date.now(), r.id);
  return { id: r.id, termId: termId ?? "" };
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

// offline works the state out from the terminal and the transcript alone: no code host call and nothing saved
async function refresh(r: ReviewRow, offline = false): Promise<ReviewRow> {
  if (r.status === "done" || r.status === "stopped") return r;

  const term = listTerms().find((t) => t.id === r.term_id);
  const live = listSessions({ liveOnly: true });
  // Claude Code's by its process, another agent's by the terminal it runs in
  const session = (r.session_id && live.find((s) => s.id === r.session_id)) || live.find((s) => !!r.pid && s.pid === r.pid) || live.find((s) => !!r.term_id && s.term === r.term_id);
  const next = { ...r, session_id: session?.id ?? r.session_id };

  const file = next.session_id ? sessionFile(next.session_id) : undefined;
  if (file) {
    const tail = await readTail(file, 512 * 1024).catch(() => undefined);
    const parse = isCodexTerminal(next.session_id!) ? codexEntries : (l: string) => parseLine(l);
    // a second look in the same session starts again from started_at; an entry without a readable time still counts
    const texts = (tail?.lines ?? []).flatMap(parse).flatMap((e) => (e.kind === "assistant" && !(Date.parse(e.ts) < r.started_at) ? [e.text] : []));
    const out = readOutcome(texts);
    next.review_url = out.reviewUrl ?? next.review_url;
    next.verdict = out.verdict ?? next.verdict;
  }

  const ended = !term || term.exited !== undefined;
  if (next.verdict && (ended || session?.status === "idle")) {
    next.status = "done";
    if (offline) return next;
    const pending = await pendingReview({ repo: r.repo, n: r.pr }).catch(() => undefined);
    if (pending) {
      next.review_url = pending.url;
      next.comments = pending.comments;
    }
  } else if (ended) next.status = "stopped";
  else next.status = session && session.status !== "busy" ? "waiting" : "running";

  if (!offline) update.run(next);
  return next;
}

export async function listReviews() {
  const rows = db.prepare<[], ReviewRow>("select * from reviews order by started_at desc limit 50").all();
  return Promise.all(rows.map((r) => refresh(r)));
}

// the same list for the sidebar badge, without touching the code host
export async function reviewStates() {
  const rows = db.prepare<[], ReviewRow>("select * from reviews order by started_at desc limit 50").all();
  return Promise.all(rows.map((r) => refresh(r, true)));
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
  if (!r.session_id) throw new Error("No session was recorded for this review, so start it again from the PR.");

  const cwd = config.reviews.cwd || config.repo.path;
  // a review Codex did resumes in Codex, by its id for the conversation
  const next = spawnTerm({ cwd, ...resumeLaunch(r.session_id), title: `review #${r.pr}`, session: r.session_id });
  db.prepare("update reviews set term_id = ?, pid = ?, status = 'running' where id = ?").run(next.id, next.pid ?? null, id);
  return { id, termId: next.id };
}
