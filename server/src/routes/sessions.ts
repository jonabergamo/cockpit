import { Hono } from "hono";
import { getSession, listSessions, listSubagents } from "../claude/sessions.ts";
import { tailEntries } from "../claude/entries.ts";
import { findSession, onNode, searchEverywhere } from "../remote/sessions.ts";
import { searchHistory } from "../claude/history.ts";
import { askOf, sendKeys, sendText } from "../agents.ts";

export const sessions = new Hono()
  .get("/", (c) => {
    const q = c.req.query();
    return c.json(listSessions({ q: q.q, ticket: q.ticket, worktree: q.worktree, liveOnly: q.live === "1", limit: Number(q.limit) || 300 }));
  })
  .get("/search", async (c) => c.json(await searchEverywhere(c.req.query("q") ?? "")))
  .get("/history", async (c) => c.json(await searchHistory(c.req.query("q") ?? "", Number(c.req.query("limit")) || 100)))
  .get("/:id", async (c) => {
    await findSession(c.req.param("id"));
    const s = getSession(c.req.param("id"));
    return s ? c.json(s) : c.notFound();
  })
  .get("/:id/entries", async (c) => {
    const id = c.req.param("id");
    const agent = c.req.query("agent");
    const bytes = Number(c.req.query("bytes")) || undefined;
    const r = await onNode(id, (n) => n.request("session.entries", { id, agent, bytes }), () => tailEntries(id, agent, bytes));
    return r ? c.json(r) : c.notFound();
  })
  .get("/:id/agents", async (c) => c.json(await onNode(c.req.param("id"), (n) => n.request("session.agents", { id: c.req.param("id") }), () => listSubagents(c.req.param("id")))))
  .get("/:id/ask", async (c) => c.json(await onNode(c.req.param("id"), (n) => n.request("session.ask", { id: c.req.param("id") }), () => askOf(c.req.param("id")))))
  // false means cockpit can't reach its pane; the caller resumes it in a terminal instead
  .post("/:id/send", async (c) => {
    const { text } = await c.req.json<{ text: string }>();
    if (!text?.trim()) return c.json({ error: "nothing to send" }, 400);
    const id = c.req.param("id");
    return c.json({ sent: await onNode(id, (n) => n.request<boolean>("session.send", { id, text }), () => sendText(id, text)) });
  })
  .post("/:id/keys", async (c) => {
    const id = c.req.param("id");
    const keys = (await c.req.json<{ keys: string[] }>()).keys ?? [];
    return c.json({ sent: await onNode(id, (n) => n.request<boolean>("session.keys", { id, keys }), () => sendKeys(id, keys)) });
  });
