import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { headless } from "../placement/headless.ts";
import { where } from "../placement/where.ts";
import { findOwner } from "../remote/work.ts";
import { backups, createMemory, doctor, listFiles, memories, readBackup, readConfig, writeConfig } from "../claude/memory.ts";
import { getSession, projectsDir } from "../claude/sessions.ts";
import { getRun, listRuns } from "../claude/workflows.ts";
import { config } from "../config.ts";
import { allowedRoot, gitRoot, insideSaved } from "../files.ts";
import { type EpicRef, openLead } from "../lead.ts";
import { spawnTerm } from "../pty.ts";
import { claudeArgs, promptFor, templateFor, templateOf } from "../templates.ts";
import { statusesOf } from "../providers.ts";
import { ask } from "../ask.ts";
import { spawnRemote } from "../remote/terminals.ts";

export const claude = new Hono()
  .get("/files", async (c) => c.json(await listFiles()))
  .get("/file", async (c) => c.json(await readConfig(c.req.query("path")!)))
  .put("/file", async (c) => {
    const { path, content, mtime } = await c.req.json<{ path: string; content: string; mtime?: number }>();
    return c.json({ mtime: await writeConfig(path, content, mtime) });
  })
  .get("/backups", async (c) => c.json(await backups(c.req.query("path")!)))
  .get("/backups/:file", async (c) => c.text(await readBackup(c.req.param("file"))))
  .get("/memories", async (c) => c.json(await memories(join(projectsDir, c.req.query("project")!, "memory"))))
  .post("/memories", async (c) => {
    const body = await c.req.json<{ project: string; name: string; description: string; type: string; body: string; title?: string }>();
    return c.json({ path: await createMemory(join(projectsDir, body.project, "memory"), body) });
  })
  .get("/doctor", async (c) => c.json(await doctor()))
  .get("/workflows", async (c) => c.json(await listRuns()))
  .get("/workflows/:id", async (c) => {
    const run = await getRun(c.req.param("id"));
    return run ? c.json(run) : c.notFound();
  })
  // Starts an interactive claude in a terminal, optionally resuming a session or with a first prompt
  // Starts an interactive claude in a terminal: resuming a given session, the resume picker, or a fresh one
  .post("/launch", async (c) => {
    const { cwd, resume, picker, prompt, title, ticket, node } = await c.req.json<{ cwd?: string; resume?: string; picker?: boolean; prompt?: string; title?: string; ticket?: string; node?: string }>();

    // on a node: the folder is that machine's, so it's the node that knows whether it exists
    if (node && node !== "local") {
      if (!cwd) return c.json({ error: "say which folder on that machine" }, 400);
      try {
        return c.json(await spawnRemote(node, { cwd, command: "claude", args: picker ? ["--resume"] : prompt ? [prompt] : [], title: title ?? (picker ? "claude --resume" : "claude") }));
      } catch (e) {
        return c.json({ error: (e as Error).message }, ((e as { status?: number }).status ?? 500) as 500);
      }
    }

    if (resume) {
      // claude only finds a session from the folder it ran in, so use the one we indexed
      const s = getSession(resume);
      // a prompt rides along as the first new message of the resumed session
      const args = ["--resume", resume, ...(prompt ? [prompt] : [])];
      // one that ran on a node resumes there, in the folder it ran in
      if (s?.node) {
        try {
          return c.json(await spawnRemote(s.node, { cwd: s.cwd, command: "claude", args, title: title ?? s.title ?? `resume ${resume.slice(0, 8)}`, session: resume }));
        } catch (e) {
          return c.json({ error: (e as Error).message }, ((e as { status?: number }).status ?? 500) as 500);
        }
      }
      if (!s?.cwd || !existsSync(s.cwd)) return c.json({ error: "session folder not found" }, 404);
      return c.json(spawnTerm({ cwd: s.cwd, command: "claude", args, title: title ?? s.title ?? `resume ${resume.slice(0, 8)}`, session: resume }));
    }

    const ok = cwd && ((await allowedRoot(cwd)) || cwd === config.repo.path || insideSaved(cwd) || (await allowedRoot((await gitRoot(cwd)) ?? cwd)));
    if (!ok) return c.json({ error: "cwd not allowed" }, 403);
    if (ticket && !picker) {
      // starting on a ticket: the kind of work its worktree was made as, or the one the ticket matches
      const t = (await statusesOf([ticket]).catch(() => []))[0];
      const tpl = templateOf(cwd) ?? templateFor({ summary: t?.summary, type: t?.type });
      const args = claudeArgs(tpl, promptFor(tpl, { key: ticket, url: t?.url, summary: t?.summary }) ?? prompt);
      return c.json(spawnTerm({ cwd, command: "claude", args, title: title ?? ticket }));
    }
    const args = picker ? ["--resume"] : prompt ? [prompt] : [];
    return c.json(spawnTerm({ cwd, command: "claude", args, title: title ?? (picker ? "claude --resume" : "claude") }));
  })
  // The lead: one long-running Claude per repo that plans with you and runs the work through cockpit's tools.
  // Opens its terminal when it's running, resumes it when it isn't, or starts one.
  // With an epic, the lead for that epic: its own session that starts from the epic and its tickets.
  .post("/lead", async (c) => {
    const body = await c.req.json<{ epic?: EpicRef }>().catch(() => ({}) as { epic?: EpicRef });
    const e = body.epic;
    if (e && !/^[A-Z][A-Z0-9]+-\d+$/.test(e.key ?? "")) return c.json({ error: "not a ticket key" }, 400);
    try {
      return c.json(openLead(e && { key: e.key, summary: e.summary?.slice(0, 200), url: /^https:\/\//.test(e.url ?? "") ? e.url : undefined }));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 500) as 400);
    }
  })
  // a question about your work, answered from cockpit's index; the job's output is the answer
  .post("/question", async (c) => {
    const { question } = await c.req.json<{ question?: string }>();
    if (!question?.trim() || question.length > 1000) return c.json({ error: "ask a question, up to 1000 characters" }, 400);
    return c.json(await ask(question.trim()));
  })
  .post("/ask", async (c) => {
    const { cwd, prompt } = await c.req.json<{ cwd?: string; prompt: string }>();
    // in a folder of a node it runs there; otherwise wherever Settings → Machines puts claude -p
    const node = cwd ? await findOwner(cwd) : where("headless");
    try {
      return c.json(await headless({ label: "claude -p", prompt, cwd }, undefined, node));
    } catch (e) {
      return c.json({ error: (e as Error).message }, ((e as { status?: number }).status ?? 502) as 502);
    }
  });
