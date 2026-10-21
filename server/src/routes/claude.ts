import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { backups, createMemory, doctor, listFiles, memories, readBackup, readConfig, writeConfig } from "../claude/memory.ts";
import { getSession, listSessions, projectsDir } from "../claude/sessions.ts";
import { readRow, writeRow } from "../settings.ts";
import { getRun, listRuns } from "../claude/workflows.ts";
import { config } from "../config.ts";
import { allowedRoot, gitRoot, insideSaved } from "../files.ts";
import { startJob } from "../jobs.ts";
import { listTerms, spawnTerm } from "../pty.ts";
import { fill } from "../util.ts";

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
    const { cwd, resume, picker, prompt, title } = await c.req.json<{ cwd?: string; resume?: string; picker?: boolean; prompt?: string; title?: string }>();

    if (resume) {
      // claude only finds a session from the folder it ran in, so use the one we indexed
      const s = getSession(resume);
      if (!s?.cwd || !existsSync(s.cwd)) return c.json({ error: "session folder not found" }, 404);
      // a prompt rides along as the first new message of the resumed session
      const args = ["--resume", resume, ...(prompt ? [prompt] : [])];
      return c.json(spawnTerm({ cwd: s.cwd, command: "claude", args, title: title ?? s.title ?? `resume ${resume.slice(0, 8)}`, session: resume }));
    }

    const ok = cwd && ((await allowedRoot(cwd)) || cwd === config.repo.path || insideSaved(cwd) || (await allowedRoot((await gitRoot(cwd)) ?? cwd)));
    if (!ok) return c.json({ error: "cwd not allowed" }, 403);
    const args = picker ? ["--resume"] : prompt ? [prompt] : [];
    return c.json(spawnTerm({ cwd, command: "claude", args, title: title ?? (picker ? "claude --resume" : "claude") }));
  })
  // The lead: one long-running Claude per repo that plans with you and runs the work through cockpit's tools.
  // Opens its terminal when it's running, resumes it when it isn't, or starts one.
  .post("/lead", (c) => {
    if (!config.repo.path || !existsSync(config.repo.path)) return c.json({ error: "Set repo.path in config.local.toml first" }, 400);
    const key = `lead:${config.repo.path}`;
    const saved = readRow<{ term?: string; session?: string }>(key) ?? {};
    const terms = listTerms();
    const term = saved.term && terms.find((t) => t.id === saved.term && t.exited === undefined);
    // the session that started in its terminal, remembered for next time
    const live = term && listSessions({ liveOnly: true }).find((s) => s.term === term.id || (!!term.pid && s.pid === term.pid));
    if (live && live.id !== saved.session) writeRow(key, { ...saved, session: live.id });
    if (term) return c.json(term);
    const system = "You are the lead for this repository in cockpit. Use the cockpit-lead skill and the cockpit MCP tools (list_workers, start_task, read_screen, send_message, answer_prompt, pr_status) to plan with the user and run the work through workers. Start by asking what we're working on, unless they already said.";
    const resume = saved.session && getSession(saved.session) ? ["--resume", saved.session] : [];
    const t = spawnTerm({ cwd: config.repo.path, command: "claude", args: [...resume, "--append-system-prompt", system], title: `lead · ${config.repo.name}`, session: resume.length ? saved.session : undefined });
    writeRow(key, { ...saved, term: t.id });
    return c.json(t);
  })
  .post("/ask", async (c) => {
    const { cwd, prompt } = await c.req.json<{ cwd?: string; prompt: string }>();
    return c.json(startJob("claude -p", fill("claude -p {prompt}", { prompt }), cwd ?? process.env.HOME));
  });
