import { Hono } from "hono";
import * as files from "../files.ts";
import * as term from "../pty.ts";
import { listWorktrees } from "../worktrees.ts";
import { spawnRemote } from "../remote/terminals.ts";

// Every request carries the root it works on; it must be a worktree or a project under extraRoots.
const code = new Hono<{ Variables: { root: string } }>();

code.use("/fs/*", async (c, next) => {
  const root = c.req.query("root") ?? "";
  if (!(await files.allowedRoot(root))) return c.json({ error: "root not allowed" }, 403);
  c.set("root", root);
  await next();
});

code
  .get("/roots", async (c) => {
    const wts = await listWorktrees(false);
    return c.json({ worktrees: wts.map((w) => ({ path: w.path, name: w.name, branch: w.branch, ticket: w.ticket })), projects: await files.projectRoots(), folders: files.savedFolders() });
  })
  .get("/dirs", async (c) => c.json(await files.listDirs(c.req.query("path") ?? "")))
  .post("/folders", async (c) => {
    try {
      return c.json({ path: files.saveFolder((await c.req.json<{ path: string }>()).path) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  })
  .delete("/folders", (c) => {
    files.forgetFolder(c.req.query("path") ?? "");
    return c.json({ ok: true });
  })
  .get("/fs/tree", async (c) => c.json(await files.tree(c.var.root)))
  .get("/fs/changes", async (c) => c.json(await files.changes(c.var.root)))
  .get("/fs/info", async (c) => c.json(await files.branchInfo(c.var.root)))
  .get("/fs/history", async (c) => c.json(await files.history(c.var.root, Number(c.req.query("limit") ?? 50))))
  .get("/fs/commit", async (c) => {
    try {
      const sha = c.req.query("sha") ?? "";
      const path = c.req.query("path");
      return c.json(path ? await files.commitFile(c.var.root, sha, path, c.req.query("from")) : await files.commitFiles(c.var.root, sha));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  })
  .get("/fs/file", async (c) => c.json(await files.read(c.var.root, c.req.query("path")!)))
  .put("/fs/file", async (c) => {
    const { path, content, mtime } = await c.req.json<{ path: string; content: string; mtime?: number }>();
    return c.json({ mtime: await files.write(c.var.root, path, content, mtime) });
  })
  .get("/fs/head", async (c) => c.json({ content: await files.headVersion(c.var.root, c.req.query("path")!) }))
  .get("/fs/diff", async (c) => c.text(await files.diff(c.var.root, c.req.query("path"))))
  .get("/fs/search", async (c) => c.json(await files.search(c.var.root, c.req.query("q") ?? "")))
  .post("/fs/stage", async (c) => {
    const { paths, on } = await c.req.json<{ paths: string[]; on: boolean }>();
    await files.stage(c.var.root, paths, on);
    return c.json({ ok: true });
  })
  .post("/fs/discard", async (c) => {
    await files.discard(c.var.root, (await c.req.json<{ path: string }>()).path);
    return c.json({ ok: true });
  })
  .post("/fs/commit", async (c) => c.json({ out: await files.commit(c.var.root, (await c.req.json<{ message: string }>()).message) }))
  .post("/fs/push", async (c) => c.json({ out: await files.push(c.var.root) }))
  .get("/terms", (c) => c.json(term.listTerms()))
  .post("/terms", async (c) => {
    const body = await c.req.json<{ cwd: string; title?: string; command?: string; args?: string[]; parent?: string; node?: string }>();
    if (body.node && body.node !== "local") {
      const { node, ...opts } = body;
      try {
        return c.json(await spawnRemote(node, opts));
      } catch (e) {
        return c.json({ error: (e as Error).message }, ((e as { status?: number }).status ?? 500) as 500);
      }
    }
    // a subfolder is fine as long as its repo is one cockpit knows, e.g. the split shell next to a claude started in an app folder
    const ok = (await files.allowedRoot(body.cwd)) || body.cwd === process.env.HOME || files.insideSaved(body.cwd) || (await files.allowedRoot((await files.gitRoot(body.cwd)) ?? body.cwd));
    if (!ok) return c.json({ error: "cwd not allowed" }, 403);
    return c.json(term.spawnTerm(body));
  })
  .post("/terms/:id/paste", async (c) => {
    try {
      return c.json({ path: await files.savePaste(await c.req.arrayBuffer(), c.req.query("name") ?? "") });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  })
  // typing into a terminal from outside it, for plugin screens; the app itself uses the socket
  .post("/terms/:id/input", async (c) => {
    term.input(c.req.param("id"), (await c.req.json<{ data: string }>()).data);
    return c.json({ ok: true });
  })
  .get("/terms/:id/changes", async (c) => {
    const cwd = term.currentCwd(c.req.param("id"));
    const root = cwd && (await files.gitRoot(cwd));
    if (!root || !(await files.allowedRoot(root))) return c.json({ root: null, cwd: cwd ?? null, changes: [] });
    return c.json({ root, cwd, changes: await files.changes(root) });
  })
  .delete("/terms/:id", (c) => {
    term.kill(c.req.param("id"));
    return c.json({ ok: true });
  });

export { code };
