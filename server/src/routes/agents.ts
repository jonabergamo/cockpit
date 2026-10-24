import { Hono } from "hono";
import type { AgentAccess } from "@cockpit/shared";
import { getSession } from "../claude/sessions.ts";
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
  return spawnTerm({ cwd: row.cwd, command: agentBin(p), args: p.terminal(row.native_id ?? undefined, row.model ?? undefined), title: `${p.name} · ${row.title ?? row.cwd}` });
}

const ACCESS = new Set<AgentAccess>(["sandbox", "full", "readonly"]);

export const agents = new Hono()
  .get("/", async (c) => c.json(await listAgents()))
  // a new conversation with an agent, run a turn at a time in a folder
  .post("/sessions", async (c) => {
    const b = await c.req.json<{ agent: string; cwd: string; prompt: string; model?: string; title?: string; access?: AgentAccess }>();
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
