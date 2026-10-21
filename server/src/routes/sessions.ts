import { Hono } from "hono";
import { agentFile, getSession, listSessions, listSubagents, sessionFile } from "../claude/sessions.ts";
import { parseLine, readTail } from "../claude/transcript.ts";
import { searchHistory } from "../claude/history.ts";
import { searchSessions } from "../claude/search.ts";
import { askOf, sendKeys, sendText } from "../agents.ts";

export const sessions = new Hono()
  .get("/", (c) => {
    const q = c.req.query();
    return c.json(listSessions({ q: q.q, ticket: q.ticket, worktree: q.worktree, liveOnly: q.live === "1", limit: Number(q.limit) || 300 }));
  })
  .get("/search", (c) => c.json(searchSessions(c.req.query("q") ?? "")))
  .get("/history", async (c) => c.json(await searchHistory(c.req.query("q") ?? "", Number(c.req.query("limit")) || 100)))
  .get("/:id", (c) => {
    const s = getSession(c.req.param("id"));
    return s ? c.json(s) : c.notFound();
  })
  .get("/:id/entries", async (c) => {
    const id = c.req.param("id");
    const agent = c.req.query("agent");
    const file = agent ? await agentFile(id, agent) : sessionFile(id);
    if (!file) return c.notFound();
    const bytes = Math.min(Number(c.req.query("bytes")) || 3 * 1024 * 1024, 64 * 1024 * 1024);
    const tail = await readTail(file, bytes);
    return c.json({ entries: tail.lines.flatMap((l) => parseLine(l)), offset: tail.offset, truncated: tail.truncated });
  })
  .get("/:id/agents", async (c) => c.json(await listSubagents(c.req.param("id"))))
  .get("/:id/ask", async (c) => c.json(await askOf(c.req.param("id"))))
  // false means cockpit can't reach its pane; the caller resumes it in a terminal instead
  .post("/:id/send", async (c) => {
    const { text } = await c.req.json<{ text: string }>();
    if (!text?.trim()) return c.json({ error: "nothing to send" }, 400);
    return c.json({ sent: await sendText(c.req.param("id"), text) });
  })
  .post("/:id/keys", async (c) => c.json({ sent: sendKeys(c.req.param("id"), (await c.req.json<{ keys: string[] }>()).keys ?? []) }));
