// The week's retro: what you kept correcting Claude on, read from your own turns in the last 7 days, and the checks
// a session failed again and again before they passed. Each recurring one comes with a rule you can add to a
// CLAUDE.md under "## Learned", so the next sessions don't make the same mistake.
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Retro, RetroTheme } from "@cockpit/shared";
import { writeConfig, writeProjectClaudeMd } from "./claude/memory.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { byWords, slug } from "./lessons.ts";
import { quick, quickOn } from "./quick.ts";
import { BY_KIND } from "./runs.ts";
import { getSettings } from "./settings.ts";
import { run } from "./util.ts";

db.exec(`
  create table if not exists retro_themes (
    id text primary key,
    kind text not null,
    title text not null,
    count integer not null,
    sessions text not null default '[]',
    examples text not null default '[]',
    rule text not null,
    project text,
    -- what it came from: session:entry of corrections, run ids of loops, so a dismissed one stays dismissed
    sources text not null default '[]',
    state text not null default 'open',
    added_to text,
    at integer not null
  );
`);

const DAY = 864e5;
const WEEK = 7 * DAY;

// ---- corrections

const INTERRUPT = /^\[Request interrupted by user/;
const MARKERS = [
  /^(no|nope|nah)\s*([,.!]|$)/i,
  /^wrong\b/i,
  /^(that'?s|this is|it'?s) (not right|not what|wrong|incorrect)\b/i,
  /\bnot what i (asked|said|meant|wanted)\b/i,
  /\b(you|u) (forgot|missed|ignored|broke|didn'?t (read|run|check|follow|listen))\b/i,
  /\bi (said|told you|already (said|told you|asked)|asked you to|meant)\b/i,
  /^(please )?(don'?t|do not|never)\b/i,
  /^stop\s*([,.!]|$|\w+ing\b)/i,
  /\b(still|not|wrong|broken|failing) again\b/i,
  /\bagain\s*[?!]/i,
  /\bwhy did you\b/i,
  /\b(undo|revert) (that|this|it)\b/i,
];

// One of your turns that tells Claude it got something wrong. Long ones, pasted chats and command wrappers are
// prompts, not corrections.
// "don't need to" lets Claude off something rather than correcting it
const NOT = /^(please )?(don'?t|do not|no) need/i;

export function isCorrection(text: string) {
  const t = text.trim();
  if (!t || t.length > 500 || t.startsWith("<") || t.includes("<pasted_content") || INTERRUPT.test(t) || NOT.test(t)) return false;
  return MARKERS.some((m) => m.test(t));
}

// the correction words themselves say nothing about what was wrong, so grouping without a model leaves them out
const stripMarkers = (s: string) => s.replace(/\b(no|nope|nah|wrong|don'?t|do not|never|stop|again|said|told|forgot|missed|ignored|asked|meant|please|why|undo|revert)\b/gi, " ");

export interface Correction {
  key: string;
  session: string;
  text: string;
  before?: string;
}

interface TextRow {
  rowid: number;
  text: string;
  session_id: string;
  entry_id: string;
  role: string;
}

// your turns in the window that are corrections, each with the end of the answer it was about, and how many times
// you interrupted a turn
export function corrections(from: number, to = Date.now()) {
  const rows = db
    .prepare<[string, string], TextRow>("select rowid, text, session_id, entry_id, role from session_text where role = 'user' and ts >= ? and ts < ?")
    .all(new Date(from).toISOString(), new Date(to).toISOString());
  // a prompt sent word for word over and over is an automation's, not you correcting anything
  const times = new Map<string, number>();
  for (const r of rows) times.set(r.text, (times.get(r.text) ?? 0) + 1);
  const near = db.prepare<[number, number], TextRow>("select rowid, text, session_id, entry_id, role from session_text where rowid >= ? and rowid < ? order by rowid desc");
  const out: Correction[] = [];
  let interrupts = 0;
  for (const r of rows) {
    if (INTERRUPT.test(r.text.trim())) {
      interrupts++;
      continue;
    }
    if (!isCorrection(r.text) || (r.text.length > 40 && (times.get(r.text) ?? 0) >= 3)) continue;
    // a transcript is indexed in order, so the answer it corrects sits just before it
    const prev = near.all(r.rowid - 20, r.rowid).find((p) => p.session_id === r.session_id && p.role === "assistant");
    out.push({ key: `${r.session_id}:${r.entry_id}`, session: r.session_id, text: oneLine(r.text, 220), before: prev && lastLine(prev.text) });
  }
  return { list: out, interrupts };
}

const oneLine = (s: string, max = 200) => {
  const t = s.replace(/```[\s\S]*?```/g, " (code) ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const lastLine = (s: string) => oneLine(s.trim().split("\n").filter((l) => l.trim()).at(-1) ?? "", 160);

// ---- fix loops

export interface RunRow {
  id: string;
  kind: string;
  name: string;
  status: string;
  session: string;
  started: number;
  cwd?: string | null;
}

export interface Loop {
  session: string;
  check: string;
  label: string;
  fails: number;
  runs: string[];
  cwd?: string;
}

const KIND_LABEL: Record<string, string> = { unit: "Tests", lint: "Lint", typecheck: "Typecheck", audit: "Audit", verify: "Checks" };

// A session that failed the same check this many times in a row before it passed: Claude going round in circles.
// The same check is what fixEarlier counts as one: the kind for whole-repo checks, the name for the rest.
export function fixLoops(runs: RunRow[], min = 3): Loop[] {
  const out: Loop[] = [];
  const streak = new Map<string, RunRow[]>();
  for (const r of [...runs].sort((a, b) => a.started - b.started)) {
    const check = BY_KIND.has(r.kind as never) ? r.kind : `${r.kind}:${r.name}`;
    const key = `${r.session}\n${check}`;
    if (r.status === "fail") streak.set(key, [...(streak.get(key) ?? []), r]);
    else if (r.status === "pass") {
      const fails = streak.get(key) ?? [];
      if (fails.length >= min) out.push({ session: r.session, check, label: KIND_LABEL[r.kind] ?? r.name, fails: fails.length, runs: [...fails.map((f) => f.id), r.id], cwd: r.cwd ?? undefined });
      streak.delete(key);
    }
  }
  return out;
}

const loopRuns = (from: number) =>
  db
    .prepare<[number], RunRow>(
      "select id, kind, name, status, json_extract(meta, '$.session') session, started_at started, coalesce(worktree, cwd) cwd from runs where started_at >= ? and json_extract(meta, '$.session') is not null and status in ('pass', 'fail') and kind != 'ci'",
    )
    .all(from);

// ---- adding a rule to a CLAUDE.md

// The rule as a bullet at the end of the "## Learned" section, which is made at the end of the file when there's none.
// undefined when it's there already.
export function appendLearned(content: string, rule: string) {
  const line = `- ${rule.trim().replace(/^[-*]\s+/, "")}`;
  const lines = content.split("\n");
  const head = lines.findIndex((l) => /^##\s+Learned\s*$/i.test(l));
  if (head < 0) return `${content.trimEnd()}${content.trim() ? "\n\n" : ""}## Learned\n\n${line}\n`;
  let end = lines.findIndex((l, i) => i > head && /^#{1,2}\s/.test(l));
  if (end < 0) end = lines.length;
  const section = lines.slice(head + 1, end);
  if (section.some((l) => l.trim() === line)) return;
  // after its last line with something on it, so the blank line before the next heading stays
  let at = end;
  while (at > head + 1 && !lines[at - 1].trim()) at--;
  const add = at === head + 1 ? ["", line] : [line];
  lines.splice(at, 0, ...add);
  const out = lines.join("\n");
  return out.endsWith("\n") ? out : `${out}\n`;
}

// ---- working it out

const PROMPT = `These are things a developer typed to correct their AI coding assistant, numbered, each after "=>" with the end of the assistant's answer it corrected. Find the mistakes that come up more than once and, for each, write a short title and one rule the assistant should follow from now on, as an imperative for its CLAUDE.md instructions file, like "Run the type checker before saying a change is done". Leave out one-offs. Answer with at most 8 lines and nothing else: each line the title, " :: ", the rule, then the numbers of the corrections it comes from in square brackets, like:
Claims done without testing :: Run the tests and show they pass before saying a change is done [2, 7, 9]

Corrections:
`;

const LINE = /^\s*(?:[-*•]|\d+[.)])?\s*(.+?)\s*::\s*(.+?)\s*\[\s*([\d,\s]+)\]\s*\.?\s*$/;

export function parseThemes(answer: string, count: number) {
  const out: { title: string; rule: string; ids: number[] }[] = [];
  for (const l of answer.split("\n")) {
    const m = l.match(LINE);
    if (!m) continue;
    const ids = [...new Set(m[3].split(/[,\s]+/).map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= count).map((n) => n - 1);
    const clean = (s: string) => s.replace(/^["'`*]+|["'`*]+$/g, "").trim();
    if (ids.length >= 2 && clean(m[1]) && clean(m[2])) out.push({ title: clean(m[1]), rule: clean(m[2]), ids });
  }
  return out;
}

const metaKey = "retro:meta";
interface Meta {
  at: number;
  method: "model" | "words";
  note?: string;
  corrections: number;
  interrupts: number;
}
const readMeta = () => {
  const row = db.prepare<[string], { value: string }>("select value from cache where key = ?").get(metaKey);
  return row ? (JSON.parse(row.value) as Meta) : undefined;
};

const sessionMeta = db.prepare<[string], { title: string | null; cwd: string | null }>("select title, cwd from sessions where id = ?");

// the repo a folder belongs to, its main checkout for a worktree
const repoCache = new Map<string, string | undefined>();
async function repoOf(cwd?: string | null) {
  if (!cwd || !existsSync(cwd)) return;
  if (!repoCache.has(cwd)) {
    const dir = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeout: 5000 }).then(
      (s) => dirname(s.trim()),
      () => undefined,
    );
    repoCache.set(cwd, dir);
  }
  return repoCache.get(cwd);
}

// the repo most of these sessions ran in
async function projectOf(sessions: string[], cwds = new Map<string, string | undefined>()) {
  const tally = new Map<string, number>();
  for (const s of sessions) {
    const repo = await repoOf(cwds.get(s) ?? sessionMeta.get(s)?.cwd);
    if (repo) tally.set(repo, (tally.get(repo) ?? 0) + 1);
  }
  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0];
}

interface Found {
  kind: RetroTheme["kind"];
  title: string;
  rule: string;
  sessions: string[];
  examples: string[];
  sources: string[];
  count: number;
  cwds?: Map<string, string | undefined>;
}

let running: Promise<void> | undefined;

// Works the last 7 days out again. A dismissed or added theme stays that way when it comes back, by its wording or by
// mostly the same corrections or runs.
export function recompute(now = Date.now()) {
  running ??= (async () => {
    const from = now - WEEK;
    const { list, interrupts } = corrections(from, now);
    const found: Found[] = [];
    let method: Meta["method"] = "words";
    let note: string | undefined;
    if (list.length && quickOn()) {
      const text = list.map((c, i) => `${i + 1}. ${c.text}${c.before ? ` => ${c.before}` : ""}`).join("\n");
      const answer = await quick(PROMPT + text, { max: 800, timeoutMs: 180_000 });
      if (answer) {
        method = "model";
        for (const t of parseThemes(answer, list.length)) found.push(correctionTheme(t.title, t.rule, t.ids.map((i) => list[i])));
      } else note = "The quick model didn't answer, so these are grouped by the words they share and the rules are only a start. Refresh to try it again.";
    } else if (list.length) note = "No quick model is set (Settings → Automation → Quick answers), so these are grouped by the words they share and the rules are only a start.";
    if (method === "words") {
      const sessions = [...new Set(list.map((c) => c.session))];
      for (const g of byWords(list.map((c) => ({ pr: sessions.indexOf(c.session), body: stripMarkers(c.text) })), 8)) {
        const word = g.rule.match(/"(.+)"/)?.[1] ?? "";
        found.push(correctionTheme(`Corrections about “${word}”`, `Check what I asked about ${word} before acting on it, and ask when it's unclear.`, g.ids.map((i) => list[i])));
      }
    }

    // loops of one check grouped together, across sessions
    const loops = new Map<string, Loop[]>();
    for (const l of fixLoops(loopRuns(from))) loops.set(l.check, [...(loops.get(l.check) ?? []), l]);
    for (const ls of loops.values()) {
      const fails = ls.reduce((a, l) => a + l.fails, 0);
      const label = ls[0].label;
      const most = Math.max(...ls.map((l) => l.fails));
      found.push({
        kind: "loop",
        title: `${label} failed ${most}${ls.length > 1 ? "+" : ""} times in a row before passing`,
        rule: `When ${label.toLowerCase()} fails, read the whole output and fix every error it reports before running it again, and stop to ask after two failed attempts at the same error.`,
        sessions: [...new Set(ls.map((l) => l.session))],
        examples: ls.slice(0, 2).map((l) => `${l.fails} failures before it passed`),
        sources: ls.flatMap((l) => l.runs),
        count: fails,
        cwds: new Map(ls.map((l) => [l.session, l.cwd])),
      });
    }

    const kept = db.prepare<[], { id: string; state: string; sources: string; added_to: string | null }>("select id, state, sources, added_to from retro_themes where state != 'open'").all();
    const settled = kept.map((k) => ({ ...k, sources: new Set<string>(JSON.parse(k.sources)) }));
    const rows = await Promise.all(
      found.map(async (f) => {
        const id = `${f.kind}-${slug(f.title)}`;
        const was = settled.find((g) => g.id === id || f.sources.filter((x) => g.sources.has(x)).length * 2 >= f.sources.length);
        const sessions = f.sessions.map((s) => ({ id: s, title: sessionMeta.get(s)?.title ?? undefined }));
        return { id, f, sessions, project: await projectOf(f.sessions, f.cwds), was };
      }),
    );
    db.transaction(() => {
      db.prepare("delete from retro_themes where state = 'open'").run();
      const add = db.prepare("insert or ignore into retro_themes (id, kind, title, count, sessions, examples, rule, project, sources, state, added_to, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', null, ?)");
      for (const r of rows) {
        if (r.was) continue;
        add.run(r.id, r.f.kind, r.f.title, r.f.count, JSON.stringify(r.sessions), JSON.stringify(r.f.examples), r.f.rule, r.project ?? null, JSON.stringify(r.f.sources), now);
      }
      // settled ones from more than a few weeks back have done their job
      db.prepare("delete from retro_themes where state != 'open' and at < ?").run(now - 8 * WEEK);
      const meta: Meta = { at: now, method, note, corrections: list.length, interrupts };
      db.prepare("insert or replace into cache (key, value, updated_at) values (?, ?, ?)").run(metaKey, JSON.stringify(meta), now);
    })();
  })().finally(() => (running = undefined));
  return running;
}

function correctionTheme(title: string, rule: string, picked: Correction[]): Found {
  return {
    kind: "correction",
    title,
    rule,
    sessions: [...new Set(picked.map((c) => c.session))],
    examples: picked.slice(0, 2).map((c) => c.text),
    sources: picked.map((c) => c.key),
    count: picked.length,
  };
}

interface ThemeRow {
  id: string;
  kind: RetroTheme["kind"];
  title: string;
  count: number;
  sessions: string;
  examples: string;
  rule: string;
  project: string | null;
  state: RetroTheme["state"];
  added_to: string | null;
}
const toTheme = (r: ThemeRow): RetroTheme => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  count: r.count,
  sessions: JSON.parse(r.sessions),
  examples: JSON.parse(r.examples),
  rule: r.rule,
  project: r.project ?? undefined,
  state: r.state,
  addedTo: r.added_to ?? undefined,
});

const userFile = () => join(config.claude.dir, "CLAUDE.md");

// what's kept; worked out again in the background when it's a day old
export function retro(): Retro {
  const on = getSettings().retro.on;
  const meta = readMeta();
  if (on && !running && (!meta || Date.now() - meta.at > DAY)) recompute().catch((e) => console.error("retro", e));
  const themes = on ? db.prepare<[], ThemeRow>("select * from retro_themes order by state = 'open' desc, count desc, title").all().map(toTheme) : [];
  return { on, running: !!running, themes, at: meta?.at, method: meta?.method, note: meta?.note, corrections: meta?.corrections ?? 0, interrupts: meta?.interrupts ?? 0, userFile: userFile() };
}

const themeRow = (id: string) => {
  const r = db.prepare<[string], ThemeRow>("select * from retro_themes where id = ?").get(id);
  if (!r) throw Object.assign(new Error("That theme isn't there any more. Refresh the retro."), { status: 404 });
  return r;
};

export function dismissTheme(id: string, dismissed = true) {
  themeRow(id);
  db.prepare("update retro_themes set state = ? where id = ?").run(dismissed ? "dismissed" : "open", id);
}

// The rule, as you edited it, under "## Learned" in your own CLAUDE.md or the one at the root of the repo its
// sessions ran in. The path is always worked out here, never taken from the request; the old file is backed up.
export async function addTheme(id: string, target: "user" | "project", rule: string) {
  const r = themeRow(id);
  const text = rule.replace(/\s+/g, " ").trim();
  if (!text) throw Object.assign(new Error("The rule is empty."), { status: 400 });
  if (text.length > 500) throw Object.assign(new Error("Keep the rule to one line, under 500 characters."), { status: 400 });
  if (target === "project" && !r.project) throw Object.assign(new Error("Its sessions didn't run in a repo cockpit can find, so it can only go to your own CLAUDE.md."), { status: 400 });
  const path = target === "project" ? join(r.project!, "CLAUDE.md") : userFile();
  const s = await stat(path).catch(() => undefined);
  const before = s ? await readFile(path, "utf8") : "";
  const after = appendLearned(before, text);
  if (after !== undefined) {
    if (target === "project") await writeProjectClaudeMd(path, after, s?.mtimeMs);
    else await writeConfig(path, after, s?.mtimeMs);
  }
  db.prepare("update retro_themes set state = 'added', rule = ?, added_to = ? where id = ?").run(text, path, id);
  return path;
}
