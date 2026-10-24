import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { RunDetail, RunEvent, RunFilter, RunKind, RunStatus } from "@cockpit/shared";
import { config, paths } from "../config.ts";
import { runPanels, runStartExtras, runSteps } from "../plugins.ts";
import { appendRun, deleteRun, filesDir, originalOf, restoreVideo, trimVideo, getRun, KINDS, listRuns, logFile, outputTail, recordHook, recordRun, rerun, settled, startRun, stepLines, type HookPayload } from "../runs.ts";
import { runOptions, startOption } from "../runnable.ts";
import { sendRunFailure } from "../verify.ts";

const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 });
const SOURCE = /^[\w:.-]{1,60}$/;

// ---- the Claude Code hook in ~/.claude/settings.json ----

const hookBin = join(paths.root, "bin", "cockpit-hook");
const settingsFile = () => join(config.claude.dir, "settings.json");
const hookCommand = () => `${config.port !== 8770 ? `COCKPIT_URL=http://127.0.0.1:${config.port} ` : ""}node ${hookBin}`;
const EVENTS = ["PostToolUse", "PostToolUseFailure"] as const;
const ours = (h: { command?: string }) => typeof h.command === "string" && h.command.includes("cockpit-hook");

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };
function readClaudeSettings(): Record<string, any> {
  if (!existsSync(settingsFile())) return {};
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch (e) {
    throw Object.assign(new Error(`can't read ${settingsFile()}: ${(e as Error).message}`), { status: 400 });
  }
}
const hookState = () => {
  const hooks = readClaudeSettings().hooks ?? {};
  const has = (ev: string) => ((hooks[ev] ?? []) as HookEntry[]).some((e) => e.hooks?.some(ours));
  return { installed: EVENTS.every(has), partly: EVENTS.some(has), command: hookCommand(), file: settingsFile() };
};

// Adds the hook (keeping one that's already there, and every other hook) or takes only ours out
function setHook(on: boolean) {
  const s = readClaudeSettings();
  const hooks: Record<string, HookEntry[]> = s.hooks ?? {};
  for (const ev of EVENTS) {
    const list = (hooks[ev] ?? []).map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !ours(h)) })).filter((e) => e.hooks.length);
    if (on) list.push({ matcher: "Bash", hooks: [{ type: "command", command: hookCommand(), timeout: 10, async: true } as { type: string; command: string }] });
    if (list.length) hooks[ev] = list;
    else delete hooks[ev];
  }
  s.hooks = hooks;
  if (!Object.keys(hooks).length) delete s.hooks;
  mkdirSync(config.claude.dir, { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2) + "\n");
  return hookState();
}

const types: Record<string, string> = { video: "video/mp4", image: "image/png", text: "text/plain; charset=utf-8" };
const byExt: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json", ".html": "text/plain; charset=utf-8" };

const filter = (q: Record<string, string>): RunFilter => ({
  ticket: q.ticket || undefined,
  worktree: q.worktree || undefined,
  kind: KINDS.includes(q.kind as RunKind) ? (q.kind as RunKind) : undefined,
  status: ["running", "pass", "fail", "cancelled"].includes(q.status) ? (q.status as RunStatus) : undefined,
  since: Number(q.since) || undefined,
  limit: Number(q.limit) || undefined,
});

export const runs = new Hono()
  .get("/", (c) => c.json(listRuns(filter(c.req.query()))))
  // Starts a run that reports as it goes (a recording script, `cockpit run`); finished: true records one already over.
  // Fields it doesn't know go in the run's meta.
  .post("/", async (c) => {
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const { name, kind, ticket, worktree, branch, cwd, command, source, meta, finished, status, exitCode, output, startedAt, endedAt, ...rest } = b;
    const extra = Object.fromEntries(Object.entries(rest).filter(([k, v]) => /^\w{1,40}$/.test(k) && ["string", "number", "boolean"].includes(typeof v)));
    const input = {
      name: typeof name === "string" ? name : undefined,
      kind: KINDS.includes(kind as RunKind) ? (kind as RunKind) : undefined,
      ticket: typeof ticket === "string" && ticket ? ticket : undefined,
      worktree: typeof worktree === "string" && worktree ? worktree : undefined,
      branch: typeof branch === "string" ? branch : undefined,
      cwd: typeof cwd === "string" ? cwd : undefined,
      command: typeof command === "string" ? command : undefined,
      startedAt: Number(startedAt) || undefined,
      meta: { ...(meta && typeof meta === "object" ? meta : {}), ...extra },
    };
    const src = typeof source === "string" && SOURCE.test(source) ? source : "script";
    if (finished) {
      const st = ["pass", "fail", "cancelled"].includes(status as string) ? (status as RunStatus) : Number(exitCode) === 0 ? "pass" : "fail";
      const r = recordRun({ ...input, status: st, exitCode: exitCode === undefined || exitCode === null ? undefined : Number(exitCode), output: typeof output === "string" ? output.slice(-512 * 1024) : undefined, endedAt: Number(endedAt) || undefined }, src);
      return c.json({ id: r.id, link: `/runs/${r.id}`, run: r });
    }
    const r = startRun(input, src);
    mkdirSync(filesDir(r.id), { recursive: true });
    // videoDir is where a recording script drops its video, then names the file in its result
    return c.json({ ...runStartExtras(r, b), id: r.id, videoDir: filesDir(r.id), filesDir: filesDir(r.id), link: `/runs/${r.id}` });
  })
  // "Run something": what can run in a worktree, and starting one of those
  .get("/options", async (c) => {
    try {
      return c.json(await runOptions(c.req.query("worktree") ?? "", { force: c.req.query("force") === "1" }));
    } catch (e) {
      return fail(e);
    }
  })
  .post("/options/start", async (c) => {
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { worktree?: unknown; id?: unknown };
    try {
      return c.json(await startOption(typeof b.worktree === "string" ? b.worktree : "", typeof b.id === "string" ? b.id : ""));
    } catch (e) {
      return fail(e);
    }
  })
  .get("/hook", (c) => {
    try {
      return c.json(hookState());
    } catch (e) {
      return fail(e);
    }
  })
  .post("/hook", async (c) => {
    try {
      return c.json(setHook(!!(await c.req.json<{ on?: boolean }>()).on));
    } catch (e) {
      return fail(e);
    }
  })
  // what bin/cockpit-hook forwards from Claude Code: a Bash call, recorded when it's a run
  .post("/hook/event", async (c) => {
    const r = recordHook(((await c.req.json().catch(() => ({}))) ?? {}) as HookPayload);
    return c.json(r ? { id: r.id } : { skipped: true });
  })
  .post("/:id/event", async (c) => {
    const r = appendRun(c.req.param("id"), ((await c.req.json().catch(() => ({}))) ?? {}) as RunEvent);
    return r ? c.json({ ok: true }) : c.json({ error: "no such run" }, 404);
  })
  .get("/:id", (c) => {
    const r = settled(c.req.param("id"));
    if (!r) return c.json({ error: "no such run" }, 404);
    const lines = Math.min(Math.max(Number(c.req.query("lines")) || 200, 10), 5000);
    const raw = stepLines(r.id);
    const parsed = runSteps(r.kind, raw.length ? raw : outputTail(r.id, 5000));
    const detail: RunDetail = { ...r, tail: outputTail(r.id, lines), steps: parsed ?? r.summary.steps ?? [], panels: runPanels(r.kind) };
    return c.json(detail);
  })
  .get("/:id/log", (c) => {
    const id = c.req.param("id");
    if (!getRun(id)) return c.json({ error: "no such run" }, 404);
    const file = logFile(id);
    return new Response(existsSync(file) ? Readable.toWeb(createReadStream(file)) as ReadableStream : "", { headers: { "content-type": "text/plain; charset=utf-8" } });
  })
  // a run's file, in ranges so a video can seek
  .get("/:id/artifacts/:name", (c) => {
    const r = getRun(c.req.param("id"));
    const a = r?.artifacts.find((x) => x.name === c.req.param("name"));
    // ?original=1 is the whole recording of a cut video, for changing the cut
    const file = r && a ? (c.req.query("original") && a.trimmed ? originalOf(r.id, a.name) : join(filesDir(r.id), a.name)) : "";
    if (!file || !existsSync(file)) return c.json({ error: "no such file" }, 404);
    const size = statSync(file).size;
    const ext = a!.name.slice(a!.name.lastIndexOf(".")).toLowerCase();
    const type = byExt[ext] ?? types[a!.type] ?? "application/octet-stream";
    const range = c.req.header("range")?.match(/^bytes=(\d*)-(\d*)$/);
    if (!range || (!range[1] && !range[2])) {
      return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { "content-type": type, "accept-ranges": "bytes", "content-length": String(size) } });
    }
    // "bytes=-500" is the last 500
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
      status: 206,
      headers: { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": String(end - start + 1) },
    });
  })
  // cut a video to start..end seconds of its original, or put the original back
  .post("/:id/artifacts/:name/trim", async (c) => {
    try {
      const { start, end } = await c.req.json<{ start: number; end: number }>();
      return c.json(await trimVideo(c.req.param("id"), c.req.param("name"), Number(start), Number(end)));
    } catch (e) {
      return fail(e);
    }
  })
  .post("/:id/artifacts/:name/restore", (c) => {
    try {
      return c.json(restoreVideo(c.req.param("id"), c.req.param("name")));
    } catch (e) {
      return fail(e);
    }
  })
  .delete("/:id", (c) => {
    if (!getRun(c.req.param("id"))) return c.json({ error: "no such run" }, 404);
    deleteRun(c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/:id/rerun", (c) => {
    try {
      return c.json(rerun(c.req.param("id")));
    } catch (e) {
      return fail(e);
    }
  })
  .post("/:id/send", async (c) => {
    try {
      await sendRunFailure(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
