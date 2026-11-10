// Review lessons: the review comments left on your PRs, and the ones your own reviews left, kept instead of
// vanishing, and distilled into the few points reviewers keep raising. Ask for the PR has the session check its
// diff against them before it opens the PR.
import type { ReviewComment, ReviewLesson, ReviewLessons } from "@cockpit/shared";
import { db } from "./db.ts";
import { myPrs, parsePr, reviewComments } from "./providers.ts";
import { quick, quickOn } from "./quick.ts";
import { getSettings } from "./settings.ts";

db.exec(`
  create table if not exists review_comments (
    id integer primary key autoincrement,
    repo text not null,
    pr integer not null,
    author text,
    path text not null default '',
    line integer,
    body text not null,
    at text,
    mine integer not null default 0,
    unique (repo, pr, path, body)
  );
  -- merged PRs whose comments are all in, so they aren't asked for again
  create table if not exists review_comment_prs (repo text not null, pr integer not null, at integer not null, primary key (repo, pr));
  create table if not exists review_lessons (
    id text primary key,
    rule text not null,
    count integer not null,
    prs integer not null,
    examples text not null default '[]',
    comment_ids text not null default '[]',
    dismissed integer not null default 0,
    at integer not null
  );
`);

const insert = db.prepare("insert or ignore into review_comments (repo, pr, author, path, line, body, at, mine) values (?, ?, ?, ?, ?, ?, ?, ?)");

// mine: these are your own review's comments. Otherwise they were left on your PR, and your replies there aren't
// lessons, nor are bots'.
export function saveComments(repo: string, pr: number, list: ReviewComment[], mine = false) {
  let n = 0;
  db.transaction(() => {
    for (const c of list) {
      const body = c.body?.trim();
      if (!body || (!mine && c.mine) || /\[bot\]$/.test(c.author ?? "")) continue;
      n += insert.run(repo, pr, c.author ?? null, c.path ?? "", c.line ?? null, body, c.at ?? null, mine ? 1 : 0).changes;
    }
  })();
  return n;
}

const DAY = 24 * 3600_000;

// The comments on your PRs merged in the last 90 days that aren't kept yet, a few PRs at a time
export async function collect(max = 15) {
  const prs = (await myPrs(false)).filter((p) => p.state === "MERGED" && Date.now() - Date.parse(p.mergedAt ?? p.createdAt) < 90 * DAY);
  const seen = db.prepare<[string, number]>("select 1 from review_comment_prs where repo = ? and pr = ?");
  let asked = 0;
  for (const p of prs) {
    const ref = parsePr(p.url);
    if (!ref || seen.get(ref.repo, ref.n)) continue;
    if (asked++ >= max) break;
    const list = await reviewComments(ref).catch((e) => {
      console.error(`review lessons: comments of #${ref.n}`, (e as Error).message);
      return null;
    });
    // the code host can't list them at all
    if (list === undefined) return;
    if (!list) continue;
    saveComments(ref.repo, ref.n, list);
    db.prepare("insert or replace into review_comment_prs (repo, pr, at) values (?, ?, ?)").run(ref.repo, ref.n, Date.now());
  }
}

interface Row {
  id: number;
  repo: string;
  pr: number;
  path: string;
  body: string;
}

const oneLine = (s: string, max = 240) => {
  const t = s.replace(/```[\s\S]*?```/g, " (code) ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

export interface Found {
  rule: string;
  ids: number[];
}

const RULE = /^\s*(?:[-*•]|\d+[.)])?\s*(.+?)\s*[[(]\s*(?:comments?:?\s*)?([\d,\s]+)[\])]\s*\.?\s*$/i;

// "Handle the empty state of lists [3, 17, 42]" a line, by the numbers the model was shown
export function parseRules(answer: string, count: number): Found[] {
  const out: Found[] = [];
  for (const line of answer.split("\n")) {
    const m = line.match(RULE);
    if (!m) continue;
    const ids = [...new Set(m[2].split(/[,\s]+/).map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= count);
    const rule = m[1].replace(/^["'`*]+|["'`*:]+$/g, "").trim();
    if (rule && ids.length >= 2) out.push({ rule, ids: ids.map((n) => n - 1) });
  }
  return out;
}

const STOP = new Set(
  "this that with from have here there what when where which would could should about into your their them they then than were been being does done just like also only some more most much very make made need needs maybe please think sure could will shall here's it's don't doesn't isn't can't won't let's thanks thank good nice looks look still other each every same instead because while after before using used use since these those again something anything nothing why how its our out all any not but can for and the are was you has had get got way one two new now see".split(" "),
);
const words = (s: string) => new Set((oneLine(s, 2000).toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP.has(w)));

// Without a model: the words that come up in comments on more than one PR, each comment counted once
export function byWords(rows: Pick<Row, "pr" | "body">[], max = 10): Found[] {
  const sets = rows.map((r) => words(r.body));
  const left = new Set(rows.map((_, i) => i));
  const out: Found[] = [];
  while (out.length < max) {
    const tally = new Map<string, number[]>();
    for (const i of left) for (const w of sets[i]) tally.set(w, [...(tally.get(w) ?? []), i]);
    const best = [...tally]
      .filter(([, ids]) => ids.length >= 3 && new Set(ids.map((i) => rows[i].pr)).size >= 2)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
    if (!best) break;
    out.push({ rule: `Comments about "${best[0]}"`, ids: best[1] });
    for (const i of best[1]) left.delete(i);
  }
  return out;
}

const PROMPT = `These are code review comments left on pull requests, numbered. Find the points that come up again and again, and write each as one short rule a developer can check their own diff against before opening a PR, like "Handle the loading and error states of every request". Leave out one-offs, praise and questions about a single line. Answer with at most 10 lines and nothing else: each line one rule, then the numbers of the comments it comes from in square brackets, like:
Handle the empty state of lists [3, 17, 42]

Comments:
`;

const metaKey = "review-lessons:meta";
interface Meta {
  at: number;
  method: "model" | "words";
  note?: string;
}
const readMeta = () => {
  const row = db.prepare<[string], { value: string }>("select value from cache where key = ?").get(metaKey);
  return row ? (JSON.parse(row.value) as Meta) : undefined;
};

interface LessonRow {
  id: string;
  rule: string;
  count: number;
  prs: number;
  examples: string;
  comment_ids: string;
  dismissed: number;
}
const toLesson = (r: LessonRow): ReviewLesson => ({ id: r.id, rule: r.rule, count: r.count, prs: r.prs, examples: JSON.parse(r.examples), dismissed: !!r.dismissed });

let running: Promise<void> | undefined;

// Works the lessons out again from the comments kept, after fetching the ones missing. A dismissed lesson stays
// dismissed when it comes back, by its wording or by mostly the same comments.
export function recompute() {
  running ??= (async () => {
    const failed = await collect().then(
      () => undefined,
      (e: Error) => `Couldn't fetch new review comments from the code host (${e.message}), so these come from the ones kept before.`,
    );
    const rows = db.prepare<[], Row>("select id, repo, pr, path, body from review_comments order by coalesce(at, '') desc, id desc limit 150").all();
    let found: Found[] = [];
    let method: Meta["method"] = "words";
    let note: string | undefined;
    if (rows.length && quickOn()) {
      const list = rows.map((r, i) => `${i + 1}. ${r.path ? `${r.path}: ` : ""}${oneLine(r.body)}`).join("\n");
      const answer = await quick(PROMPT + list, { max: 800, timeoutMs: 180_000 });
      if (answer) {
        found = parseRules(answer, rows.length);
        method = "model";
      } else note = "The quick model didn't answer, so these are grouped by the words that come up most. Refresh to try it again.";
    } else if (rows.length) note = "No quick model is set (Settings → Automation → Quick answers), so these are grouped by the words that come up most.";
    if (method === "words") found = byWords(rows);

    const dismissed = db.prepare<[], LessonRow>("select * from review_lessons where dismissed = 1").all();
    const gone = dismissed.map((d) => ({ id: d.id, ids: new Set<number>(JSON.parse(d.comment_ids)) }));
    const now = Date.now();
    db.transaction(() => {
      db.prepare("delete from review_lessons where dismissed = 0").run();
      const add = db.prepare("insert or ignore into review_lessons (id, rule, count, prs, examples, comment_ids, dismissed, at) values (?, ?, ?, ?, ?, ?, 0, ?)");
      for (const f of found) {
        const picked = f.ids.map((i) => rows[i]);
        const ids = picked.map((r) => r.id);
        const id = slug(f.rule);
        if (!id || gone.some((g) => g.id === id || ids.filter((x) => g.ids.has(x)).length * 2 >= ids.length)) continue;
        const examples = picked.slice(0, 2).map((r) => oneLine(r.body, 200));
        add.run(id, f.rule, ids.length, new Set(picked.map((r) => `${r.repo}#${r.pr}`)).size, JSON.stringify(examples), JSON.stringify(ids), now);
      }
      const all = [failed, note].filter(Boolean).join(" ") || undefined;
      db.prepare("insert or replace into cache (key, value, updated_at) values (?, ?, ?)").run(metaKey, JSON.stringify({ at: now, method, note: all } satisfies Meta), now);
    })();
  })().finally(() => (running = undefined));
  return running;
}

export function dismissLesson(id: string, dismissed = true) {
  const r = db.prepare("update review_lessons set dismissed = ? where id = ?").run(dismissed ? 1 : 0, id);
  if (!r.changes) throw Object.assign(new Error("That lesson isn't there any more. Refresh the lessons."), { status: 404 });
}

// the top active ones, as Ask for the PR adds them to its prompt
export function lessonsPrompt(lessons: ReviewLesson[], count = getSettings().lessons.count) {
  const top = lessons.filter((l) => !l.dismissed).slice(0, count);
  if (!top.length) return "";
  const lines = top.map((l) => `- ${l.rule} (raised ${l.count} times${l.examples[0] ? `, e.g. "${l.examples[0]}"` : ""})`);
  return `\n\nBefore opening the PR, check your diff against these points reviewers raised on recent PRs:\n${lines.join("\n")}`;
}

export function reviewLessons(): ReviewLessons {
  const meta = readMeta();
  const lessons = db.prepare<[], LessonRow>("select * from review_lessons order by dismissed, count desc, prs desc, rule").all().map(toLesson);
  const comments = (db.prepare("select count(*) as n from review_comments").get() as { n: number }).n;
  const s = getSettings().lessons;
  return { lessons, at: meta?.at, method: meta?.method, note: meta?.note, comments, prompt: s.on ? lessonsPrompt(lessons, s.count) : "" };
}

// once a day, while the setting is on
export function startLessons() {
  const tick = () => {
    if (!getSettings().lessons.on) return;
    const at = readMeta()?.at ?? 0;
    if (Date.now() - at > DAY) recompute().catch((e) => console.error("review lessons", e));
  };
  setTimeout(tick, 5 * 60_000);
  setInterval(tick, 3 * 3600_000);
}
