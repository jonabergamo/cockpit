import { Hono } from "hono";
import type { AgentAccess } from "@cockpit/shared";
import { getSession, listSessions } from "../claude/sessions.ts";
import { lastWords } from "../agents.ts";
import { config } from "../config.ts";
import { allowedRoot, gitRoot, insideSaved } from "../files.ts";
import { spawnTerm } from "../pty.ts";
import { agentBin, agentProvider, listAgents } from "../workers/index.ts";
import { agentRow, closeAgent, startAgent, stopAgent } from "../workers/runner.ts";

const fail = (e: unknown) => {
  const err = e as Error & { status?: number };
  return Response.json({ error: err.message }, { status: err.status ?? 500 });
};

// an agent's conversation in its own interactive screen, in one of cockpit's terminals
export function agentTerminal(id: string) {
  const row = agentRow(id);
  const p = row && agentProvider(row.agent);
  if (!row || !p?.terminal) return;
  // tied to the session, so its tab and card show it working
  return spawnTerm({ cwd: row.cwd, command: agentBin(p), args: p.terminal(row.native_id ?? undefined, row.model ?? undefined), title: `${p.name} · ${row.title ?? row.cwd}`, session: id });
}

const ACCESS = new Set<AgentAccess>(["sandbox", "full", "readonly"]);

export const agents = new Hono()
  .get("/", async (c) => c.json(await listAgents()))
  // a new conversation with an agent, run a turn at a time in a folder
  .post("/sessions", async (c) => {
    const b = await c.req.json<{ agent: string; cwd: string; prompt: string; model?: string; title?: string; access?: AgentAccess; parent?: string; pids?: number[] }>();
    // handed out by a Claude session through cockpit's tools: the tool's process runs under that session's Claude,
    // so one of its parent processes is the session's
    if (b.pids?.length && !b.parent) {
      const s = listSessions({ liveOnly: true }).find((x) => !x.node && !x.agent && !!x.pid && b.pids!.includes(x.pid));
      if (s) b.parent = `session:${s.id}`;
    }
    if (b.parent && !/^(session|flow):[\w-]+$/.test(b.parent)) return c.json({ error: "parent is session:<id> or flow:<id>" }, 400);
    if (!b.prompt?.trim()) return c.json({ error: "Say what it should do" }, 400);
    if (b.access && !ACCESS.has(b.access)) return c.json({ error: "access is sandbox, full or readonly" }, 400);
    // the same folders a Claude terminal may open in
    const ok = b.cwd && ((await allowedRoot(b.cwd)) || b.cwd === config.repo.path || insideSaved(b.cwd) || (await allowedRoot((await gitRoot(b.cwd)) ?? b.cwd)));
    if (!ok) return c.json({ error: "cwd not allowed" }, 403);
    try {
      return c.json(getSession(startAgent(b)));
    } catch (e) {
      return fail(e);
    }
  })
  // how it's doing: whether its turn is over, and what it said last. wait holds the answer for up to that many
  // seconds while it's still working, so a caller can wait without asking over and over
  .get("/sessions/:id/result", async (c) => {
    const id = c.req.param("id");
    const until = Date.now() + Math.min(Number(c.req.query("wait")) || 0, 110) * 1000;
    while (agentRow(id)?.status === "busy" && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
    const row = agentRow(id);
    if (!row) return c.notFound();
    return c.json({ id, agent: row.agent, title: row.title, status: row.status === "busy" ? "working" : row.error ? "failed" : "done", error: row.error ?? undefined, last: (await lastWords(id)).text, tokens: { input: row.tokens_in, output: row.tokens_out } });
  })
  .post("/sessions/:id/stop", (c) => c.json((stopAgent(c.req.param("id")), { ok: true })))
  .post("/sessions/:id/close", (c) => c.json((closeAgent(c.req.param("id")), { ok: true })))
  // the same conversation in the agent's own interactive screen
  .post("/sessions/:id/terminal", (c) => {
    const term = agentTerminal(c.req.param("id"));
    return term ? c.json(term) : c.json({ error: "This agent can't be opened in a terminal" }, 400);
  })
  // logs the agent in, in a terminal
  .post("/:id/login", (c) => {
    const p = agentProvider(c.req.param("id"));
    if (!p) return c.notFound();
    return c.json(spawnTerm({ cwd: process.env.HOME ?? "/", command: agentBin(p), args: p.login ?? [], title: `${p.name} login` }));
  });
