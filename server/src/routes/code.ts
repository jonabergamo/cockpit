import { Hono, type Context } from "hono";
import * as files from "../files.ts";
import * as term from "../pty.ts";
import { spawnRemote } from "../remote/terminals.ts";
import { allRoots, findOwner, ownerOf, requestWork } from "../remote/work.ts";

const nodeOfTerm = (id: string) => term.listTerms().find((t) => t.id === id)?.node;

// Every request carries the root it works on; it must be a worktree or a project under extraRoots. A root on a
// node goes to that node, which checks it the same way.
const code = new Hono();

const failed = (c: Context, e: unknown) => c.json({ error: (e as Error).message }, ((e as { status?: number }).status ?? 400) as 400);

code
  .all("/fs/:op", async (c) => {
    const q = c.req.query();
    const op = c.req.param("op");
    const body = c.req.method === "GET" ? {} : await c.req.json().catch(() => ({}));
    const local = !q.node && (await files.allowedRoot(q.root ?? ""));
    try {
      const node = q.node || (local ? undefined : await findOwner(q.root ?? ""));
      if (node) {
        const out = await requestWork(node, "fs", { method: c.req.method, op, q, body }, op === "push" ? 120_000 : 30_000);
        return op === "diff" ? c.text(out as string) : c.json(out);
      }
      if (!local) return c.json({ error: "root not allowed" }, 403);
      const out = await files.fsCall(q.root, c.req.method, op, q, body);
      return op === "diff" ? c.text(out as string) : c.json(out);
    } catch (e) {
      return failed(c, e);
    }
  })
  .get("/roots", async (c) => c.json(await allRoots(await files.roots())))
  .get("/dirs", async (c) => {
    const node = c.req.query("node");
    try {
      return c.json(node && node !== "local" ? await requestWork(node, "code.dirs", { path: c.req.query("path") ?? "" }) : await files.listDirs(c.req.query("path") ?? ""));
    } catch (e) {
      return failed(c, e);
    }
  })
  .post("/folders", async (c) => {
    const { path, node } = await c.req.json<{ path: string; node?: string }>();
    try {
      return c.json(node && node !== "local" ? await requestWork(node, "code.folder", { path }) : { path: files.saveFolder(path) });
    } catch (e) {
      return failed(c, e);
    }
  })
  .delete("/folders", async (c) => {
    const path = c.req.query("path") ?? "";
    const node = c.req.query("node") || ownerOf(path);
    if (node) await requestWork(node, "code.folder", { path, remove: true }).catch(() => {});
    else files.forgetFolder(path);
    return c.json({ ok: true });
  })
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
    if (!(await files.cwdAllowed(body.cwd))) return c.json({ error: "cwd not allowed" }, 403);
    return c.json(term.spawnTerm(body));
  })
  // a file dropped on a terminal is saved on the machine the terminal runs on, where its programs can read it
  .post("/terms/:id/paste", async (c) => {
    const node = nodeOfTerm(c.req.param("id"));
    try {
      if (node) return c.json(await requestWork(node, "term.paste", { data: Buffer.from(await c.req.arrayBuffer()).toString("base64"), name: c.req.query("name") ?? "" }, 60_000));
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
    const id = c.req.param("id");
    const node = nodeOfTerm(id);
    if (node) return c.json(await requestWork(node, "term.changes", { id }).catch(() => ({ root: null, cwd: null, changes: [] })));
    return c.json(await files.termChanges(term.currentCwd(id)));
  })
  .delete("/terms/:id", (c) => {
    term.kill(c.req.param("id"));
    return c.json({ ok: true });
  });

export { code };
