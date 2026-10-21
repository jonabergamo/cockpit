import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { getSession } from "../claude/sessions.ts";
import { inside } from "../files.ts";
import { captureTarget, termTarget, trustDialog } from "../agents.ts";
import { baseOf, cancelTask, createTasks, getTask, groupTasks, keepAttempt, listTasks, markDone, type NewTask, trustTask } from "../tasks.ts";
import { run } from "../util.ts";

const git = (root: string, ...args: string[]) => run("git", ["-C", root, ...args]);

// what an attempt changed against where its branch started, committed or not
async function diffStat(root: string) {
  const base = await baseOf(root);
  const files: { path: string; added: number; removed: number; status: string }[] = [];
  if (base) {
    for (const l of (await git(root, "diff", "--numstat", base).catch(() => "")).split("\n")) {
      const [a, r, path] = l.split("\t");
      if (path) files.push({ path, added: Number(a) || 0, removed: Number(r) || 0, status: "M" });
    }
    for (const l of (await git(root, "diff", "--name-status", base).catch(() => "")).split("\n")) {
      const [st, path] = l.split("\t");
      const f = files.find((x) => x.path === path);
      if (f && st) f.status = st[0];
    }
  }
  for (const path of (await git(root, "ls-files", "--others", "--exclude-standard").catch(() => "")).split("\n").filter(Boolean)) {
    const text = await readFile(join(root, path), "utf8").catch(() => "");
    files.push({ path, added: text ? text.split("\n").length : 0, removed: 0, status: "A" });
  }
  return { base, files };
}

const fail = (e: unknown) => ({ error: (e as Error).message });

export const tasks = new Hono()
  .get("/", (c) => c.json(listTasks()))
  .post("/", async (c) => {
    try {
      return c.json(await createTasks(await c.req.json<NewTask>()));
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
  .get("/group/:g", async (c) => {
    const list = groupTasks(c.req.param("g"));
    if (!list.length) return c.notFound();
    const attempts = await Promise.all(
      list.map(async (t) => {
        const s = t.sessionId ? getSession(t.sessionId) : undefined;
        const stat = t.worktree ? await diffStat(t.worktree).catch(() => undefined) : undefined;
        return { task: t, files: stat?.files ?? [], session: s && { id: s.id, status: s.status, costUSD: s.costUSD, linesAdded: s.linesAdded, linesRemoved: s.linesRemoved, updatedAt: s.updatedAt } };
      }),
    );
    return c.json({ title: list[0].title, prompt: list[0].prompt, ticket: list[0].ticket, dependsOn: list[0].dependsOn, attempts });
  })
  .get("/:id/file", async (c) => {
    const t = getTask(c.req.param("id"));
    const path = c.req.query("path") ?? "";
    if (!t?.worktree) return c.notFound();
    try {
      inside(t.worktree, path);
      const base = await baseOf(t.worktree);
      const before = base ? await git(t.worktree, "show", `${base}:${path}`).catch(() => "") : "";
      const after = await readFile(join(t.worktree, path), "utf8").catch(() => "");
      return c.json({ before, after });
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
  .post("/:id/trust", (c) => {
    try {
      trustTask(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      return c.json(fail(e), 400);
    }
  })
  .get("/:id/screen", (c) => {
    const t = getTask(c.req.param("id"));
    const screen = t?.termId ? captureTarget(termTarget(t.termId), 40) : undefined;
    return c.json({ screen: screen?.replace(/\s+$/, "") ?? "", trust: trustDialog(screen) });
  })
  .post("/:id/cancel", (c) => (cancelTask(c.req.param("id")), c.json({ ok: true })))
  .post("/:id/done", (c) => (markDone(c.req.param("id")), c.json({ ok: true })))
  .post("/:id/keep", (c) => {
    try {
      keepAttempt(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      return c.json(fail(e), 400);
    }
  });
