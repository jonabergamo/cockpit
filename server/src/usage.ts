import { existsSync, watchFile } from "node:fs";
import { limitsChanged } from "./notify.ts";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { costByDay, listSessions, projectsDir } from "./claude/sessions.ts";
import { readFrom } from "./claude/transcript.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { day } from "./util.ts";

db.exec(`
  create table if not exists usage (
    request_id text primary key,
    session_id text,
    agent text,
    ts text not null,
    model text,
    input integer not null default 0,
    output integer not null default 0,
    cache_read integer not null default 0,
    cache_write integer not null default 0,
    thinking integer not null default 0
  );
  create index if not exists usage_ts on usage (ts);

  create table if not exists files (
    path text primary key,
    offset integer not null,
    size integer not null
  );

  create table if not exists rate_limits (
    at integer primary key,
    five_pct real,
    five_resets integer,
    seven_pct real,
    seven_resets integer
  );
`);

export interface UsageRow {
  requestId: string;
  sessionId?: string;
  ts: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
}

function field(line: string, key: string, last = false) {
  const needle = `"${key}":"`;
  const i = last ? line.lastIndexOf(needle) : line.indexOf(needle);
  if (i === -1) return;
  const start = i + needle.length;
  return line.slice(start, line.indexOf('"', start));
}

// Cuts the JSON object that starts at `from` out of a line by matching braces, skipping strings.
export function objectAt(line: string, from: number) {
  let depth = 0;
  let str = false;
  for (let i = from; i < line.length; i++) {
    const ch = line[i];
    if (str) {
      if (ch === "\\") i++;
      else if (ch === '"') str = false;
      continue;
    }
    if (ch === '"') str = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return line.slice(from, i + 1);
  }
}

// Assistant lines can be huge, so only the usage object is parsed. It comes after the content,
// and a "usage" key inside the content would be escaped, so the last unescaped one is the real one.
export function usageOf(line: string): UsageRow | undefined {
  if (!line.includes('"type":"assistant"')) return;
  const requestId = field(line, "requestId");
  const at = line.lastIndexOf('"usage":{');
  if (!requestId || at === -1) return;
  const raw = objectAt(line, at + '"usage":'.length);
  if (!raw) return;
  const u = JSON.parse(raw);
  return {
    requestId,
    sessionId: field(line, "sessionId"),
    ts: field(line, "timestamp", true) ?? "",
    model: field(line, "model"),
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    thinking: u.output_tokens_details?.thinking_tokens ?? 0,
  };
}

const getFile = db.prepare<[string], { offset: number; size: number }>("select offset, size from files where path = ?");
const putFile = db.prepare("insert or replace into files (path, offset, size) values (?, ?, ?)");
const putUsage = db.prepare(`
  insert or ignore into usage (request_id, session_id, agent, ts, model, input, output, cache_read, cache_write, thinking)
  values (@requestId, @sessionId, @agent, @ts, @model, @input, @output, @cacheRead, @cacheWrite, @thinking)
`);

async function indexFile(path: string) {
  const { size } = await stat(path);
  const prev = getFile.get(path);
  if (prev?.size === size) return;
  let offset = prev && prev.offset <= size ? prev.offset : 0;
  const agent = basename(path).startsWith("agent-") ? basename(path, ".jsonl").slice(6) : null;

  while (offset < size) {
    const chunk = await readFrom(path, offset);
    if (chunk.offset === offset) break;
    const rows: UsageRow[] = [];
    for (const line of chunk.lines) {
      try {
        const u = usageOf(line);
        if (u) rows.push(u);
      } catch {
        // skip a line we can't read
      }
    }
    db.transaction(() => rows.forEach((r) => putUsage.run({ ...r, sessionId: r.sessionId ?? null, model: r.model ?? null, agent })))();
    offset = chunk.offset;
  }
  putFile.run(path, offset, size);
}

// ---------- which tools the tokens go to ----------
// Every tool call, and how much text its result put back into the context. Results are what fill the context,
// so their size (about 4 characters a token) is the cost of a tool, more than the call itself.
db.exec(`
  create table if not exists tool_usage (
    tool_use_id text primary key,
    session_id text,
    ts text not null,
    tool text not null,
    detail text,
    result_chars integer not null default 0
  );
  create index if not exists tool_usage_ts on tool_usage (ts);
  create table if not exists tool_files (path text primary key, offset integer not null, size integer not null);
`);

// "cd app && pnpm test --filter web" is a pnpm call
export function commandHead(cmd: string) {
  const parts = cmd.split(/&&|;|\|\|/).map((p) => p.trim()).filter(Boolean);
  const main = parts.find((p) => !/^(cd|export|source|set)\b/.test(p)) ?? parts[0] ?? "";
  const words = main.split(/\s+/).filter((w) => !/^\w+=/.test(w));
  const head = (words[0] ?? "").replace(/^.*\//, "");
  return ["npx", "pnpm", "npm", "yarn", "bun", "uv", "python", "python3", "node", "git", "docker", "gh"].includes(head) && words[1] && !words[1].startsWith("-") ? `${head} ${words[1]}` : head;
}

export interface ToolCall {
  id: string;
  tool: string;
  detail?: string;
  ts: string;
  sessionId?: string;
}
// the tool calls and results on one transcript line
export function toolsOf(line: string): { calls: ToolCall[]; results: { id: string; chars: number }[] } {
  const out = { calls: [] as ToolCall[], results: [] as { id: string; chars: number }[] };
  if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) return out;
  const d = JSON.parse(line);
  const content = d.message?.content;
  if (!Array.isArray(content)) return out;
  for (const c of content) {
    if (c.type === "tool_use") out.calls.push({ id: c.id, tool: c.name, detail: c.name === "Bash" && typeof c.input?.command === "string" ? commandHead(c.input.command) : undefined, ts: d.timestamp ?? "", sessionId: d.sessionId });
    if (c.type === "tool_result") out.results.push({ id: c.tool_use_id, chars: typeof c.content === "string" ? c.content.length : JSON.stringify(c.content ?? "").length });
  }
  return out;
}

const getToolFile = db.prepare<[string], { offset: number; size: number }>("select offset, size from tool_files where path = ?");
const putToolFile = db.prepare("insert or replace into tool_files (path, offset, size) values (?, ?, ?)");
const putCall = db.prepare("insert or ignore into tool_usage (tool_use_id, session_id, ts, tool, detail) values (?, ?, ?, ?, ?)");
const putResult = db.prepare("update tool_usage set result_chars = ? where tool_use_id = ?");

async function indexTools(path: string) {
  const { size } = await stat(path);
  const prev = getToolFile.get(path);
  if (prev?.size === size) return;
  let offset = prev && prev.offset <= size ? prev.offset : 0;
  while (offset < size) {
    const chunk = await readFrom(path, offset);
    if (chunk.offset === offset) break;
    const calls: ToolCall[] = [];
    const results: { id: string; chars: number }[] = [];
    for (const line of chunk.lines) {
      try {
        const t = toolsOf(line);
        calls.push(...t.calls);
        results.push(...t.results);
      } catch {}
    }
    db.transaction(() => {
      for (const c of calls) putCall.run(c.id, c.sessionId ?? null, c.ts, c.tool, c.detail ?? null);
      for (const r of results) putResult.run(r.chars, r.id);
    })();
    offset = chunk.offset;
  }
  putToolFile.run(path, offset, size);
}

export function toolReport(days: number) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const tools = db
    .prepare<[string], { tool: string; calls: number; chars: number }>("select tool, count(*) calls, sum(result_chars) chars from tool_usage where ts >= ? group by tool order by chars desc limit 25")
    .all(since);
  const commands = db
    .prepare<[string], { detail: string; calls: number; chars: number }>("select detail, count(*) calls, sum(result_chars) chars from tool_usage where ts >= ? and tool = 'Bash' and detail is not null and detail != '' group by detail order by chars desc limit 20")
    .all(since);
  const tok = (chars: number) => Math.round((chars ?? 0) / 4);
  return {
    days,
    tools: tools.map((t) => ({ name: t.tool, calls: t.calls, tokens: tok(t.chars) })),
    commands: commands.map((c) => ({ name: c.detail, calls: c.calls, tokens: tok(c.chars) })),
  };
}

async function* transcripts(dir: string): AsyncGenerator<string> {
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, d.name);
    if (d.isDirectory()) yield* transcripts(p);
    else if (d.name.endsWith(".jsonl") && d.name !== "journal.jsonl") yield p;
  }
}

let running: Promise<void> | null = null;

export function indexUsage() {
  running ??= (async () => {
    for await (const p of transcripts(projectsDir)) {
      await indexFile(p).catch(() => {});
      await indexTools(p).catch(() => {});
    }
  })().finally(() => (running = null));
  return running;
}

// --- plan limits, written by the status line --------------------------------

const limitsFile = join(config.claude.dir, "cockpit", "rate-limits.json");
const lastLimit = db.prepare<[], { at: number; five_pct: number; seven_pct: number; five_resets: number; seven_resets: number }>(
  "select * from rate_limits order by at desc limit 1",
);
const putLimit = db.prepare("insert or ignore into rate_limits (at, five_pct, five_resets, seven_pct, seven_resets) values (?, ?, ?, ?, ?)");

async function readLimits() {
  try {
    const d = JSON.parse(await readFile(limitsFile, "utf8"));
    const five = d.rate_limits?.five_hour;
    const seven = d.rate_limits?.seven_day;
    const prev = lastLimit.get();
    const same = prev && prev.five_pct === five?.used_percentage && prev.seven_pct === seven?.used_percentage && prev.five_resets === five?.resets_at;
    if (!same) putLimit.run(Math.round(d.at * 1000), five?.used_percentage ?? null, five?.resets_at ?? null, seven?.used_percentage ?? null, seven?.resets_at ?? null);
    if (typeof five?.used_percentage === "number") limitsChanged(five.used_percentage, five.resets_at);
  } catch {
    // the status line hasn't written it yet
  }
}

export function startUsage() {
  readLimits();
  watchFile(limitsFile, { interval: 5000 }, readLimits);
  setTimeout(() => indexUsage().then(() => console.log("usage indexed")), 20_000);
  setInterval(() => indexUsage().catch(() => {}), 5 * 60_000);
}

// --- report ----------------------------------------------------------------

async function planInfo() {
  try {
    const a = JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8")).oauthAccount ?? {};
    return { seatTier: a.seatTier, rateLimitTier: a.userRateLimitTier, billingType: a.billingType };
  } catch {
    return {};
  }
}

export async function usageReport(days: number) {
  days = Math.max(days, 31); // the month tile needs every day since the 1st
  await Promise.race([indexUsage(), new Promise((r) => setTimeout(r, 1500))]);

  const to = day(new Date());
  const from = day(Date.now() - (days - 1) * 864e5);
  const since = new Date(Date.now() - days * 864e5).toISOString();

  const rows = db
    .prepare<[string], { session_id: string | null; ts: string; model: string | null; input: number; output: number; cache_read: number; cache_write: number; thinking: number }>(
      "select session_id, ts, model, input, output, cache_read, cache_write, thinking from usage where ts >= ?",
    )
    .all(since);

  const costs = costByDay(from, to);
  const perDay = new Map<string, { date: string; costUSD: number; tokens: number; output: number }>();
  for (let t = Date.parse(`${from}T12:00:00`); day(t) <= to; t += 864e5) perDay.set(day(t), { date: day(t), costUSD: +(costs.get(day(t))?.cost ?? 0).toFixed(2), tokens: 0, output: 0 });

  const models = new Map<string, { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; requests: number }>();
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;

  for (const r of rows) {
    const t = new Date(r.ts);
    const d = perDay.get(day(t));
    const total = r.input + r.output + r.cache_read + r.cache_write;
    if (d) {
      d.tokens += total;
      d.output += r.output;
    }
    const m = models.get(r.model ?? "unknown") ?? { model: r.model ?? "unknown", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
    m.input += r.input;
    m.output += r.output;
    m.cacheRead += r.cache_read;
    m.cacheWrite += r.cache_write;
    m.requests++;
    models.set(m.model, m);
    heat[t.getDay()][t.getHours()] += r.output;
    input += r.input;
    output += r.output;
    cacheRead += r.cache_read;
    cacheWrite += r.cache_write;
  }

  const sessions = new Map(listSessions({ limit: 10_000 }).map((s) => [s.id, s]));
  const bySession = new Map<string, number>();
  for (const d of costs.values()) for (const [id, c] of d.sessions) bySession.set(id, (bySession.get(id) ?? 0) + c);

  const group = (key: (id: string) => string | undefined) => {
    const out = new Map<string, number>();
    for (const [id, c] of bySession) {
      const k = key(id);
      if (k) out.set(k, (out.get(k) ?? 0) + c);
    }
    return [...out].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, costUSD]) => ({ name, costUSD: +costUSD.toFixed(2) }));
  };
  const home = homedir();
  const folder = (id: string) => {
    const s = sessions.get(id);
    return s ? (s.worktree ?? s.cwd).replace(home, "~") : undefined;
  };

  const limits = db
    .prepare<[number], { at: number; five_pct: number; five_resets: number; seven_pct: number; seven_resets: number }>("select * from rate_limits where at >= ? order by at")
    .all(Date.now() - 7 * 864e5);
  const latest = limits.at(-1) ?? lastLimit.get();

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sumSince = (d: string) => [...perDay.values()].filter((x) => x.date >= d).reduce((a, x) => ({ costUSD: a.costUSD + x.costUSD, tokens: a.tokens + x.tokens }), { costUSD: 0, tokens: 0 });

  return {
    plan: await planInfo(),
    limits: {
      latest: latest && {
        at: latest.at,
        five: { pct: latest.five_pct, resetsAt: latest.five_resets ? latest.five_resets * 1000 : undefined },
        seven: { pct: latest.seven_pct, resetsAt: latest.seven_resets ? latest.seven_resets * 1000 : undefined },
      },
      series: limits.map((l) => ({ at: l.at, five: l.five_pct, seven: l.seven_pct })),
    },
    totals: {
      today: sumSince(to),
      week: sumSince(day(weekStart)),
      month: sumSince(`${to.slice(0, 7)}-01`),
      range: { costUSD: +[...perDay.values()].reduce((n, x) => n + x.costUSD, 0).toFixed(2), input, output, cacheRead, cacheWrite, requests: rows.length },
      cacheShare: input + cacheRead + cacheWrite ? cacheRead / (input + cacheRead + cacheWrite) : 0,
    },
    days: [...perDay.values()],
    models: [...models.values()].sort((a, b) => b.output - a.output),
    heat,
    top: {
      sessions: [...bySession]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, c]) => ({ id, title: sessions.get(id)?.title ?? id.slice(0, 8), folder: folder(id), costUSD: +c.toFixed(2) })),
      folders: group(folder),
      tickets: group((id) => sessions.get(id)?.ticket),
    },
    indexing: !!running,
    hasLimitsFile: existsSync(limitsFile),
  };
}
