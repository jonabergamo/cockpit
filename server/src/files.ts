import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { config, demo, paths } from "./config.ts";
import { db } from "./db.ts";
import { run } from "./util.ts";
import { listWorktrees } from "./worktrees.ts";

const MAX_FILE = 4 * 1024 * 1024;

export async function allowedRoot(root: string) {
  const r = resolve(root);
  // demo mode opens cockpit itself, or the repo its config names (the screenshots use a made-up one)
  if (demo) return r === paths.root || (!!config.repo.path && r === resolve(config.repo.path));
  if (config.extraRoots.some((base) => dirname(r) === base)) return existsSync(r);
  if (savedFolders().includes(r)) return existsSync(r);
  return (await listWorktrees(false)).some((w) => w.path === r);
}

export function inside(root: string, rel: string) {
  const p = resolve(root, rel);
  if (relative(root, p).startsWith("..")) throw new Error("path escapes root");
  return p;
}

const git = (root: string, ...args: string[]) => run("git", ["-C", root, ...args], { timeout: 30_000 });

export async function tree(root: string) {
  const out = await git(root, "ls-files", "-co", "--exclude-standard", "-z");
  return out.split("\0").filter(Boolean).sort();
}

export async function gitRoot(cwd: string) {
  return (await git(cwd, "rev-parse", "--show-toplevel").catch(() => "")).trim() || undefined;
}

export async function changes(root: string) {
  const out = await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const list: { path: string; index: string; work: string }[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    list.push({ index: p[0], work: p[1], path: p.slice(3) });
    if (p[0] === "R" || p[0] === "C") i++; // renames carry the old path as the next entry
  }
  return list;
}

export async function read(root: string, rel: string) {
  const p = inside(root, rel);
  const s = await stat(p);
  if (s.size > MAX_FILE) return { path: rel, binary: false, tooLarge: true, content: "", mtime: s.mtimeMs };
  const buf = await readFile(p);
  const binary = buf.subarray(0, 8000).includes(0);
  return { path: rel, binary, tooLarge: false, content: binary ? "" : buf.toString("utf8"), mtime: s.mtimeMs };
}

export async function write(root: string, rel: string, content: string, expectMtime?: number) {
  const p = inside(root, rel);
  if (expectMtime && existsSync(p) && Math.abs((await stat(p)).mtimeMs - expectMtime) > 1) {
    throw new Error("file changed on disk since you opened it");
  }
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
  return (await stat(p)).mtimeMs;
}

export const headVersion = (root: string, rel: string) => git(root, "show", `HEAD:${rel}`).catch(() => "");

export const diff = (root: string, rel?: string) => git(root, "diff", "HEAD", "--", ...(rel ? [rel] : []));

export async function search(root: string, q: string) {
  if (!q) return [];
  // git grep exits 1 when nothing matches
  const out = await git(root, "grep", "-n", "-I", "-i", "-F", "--untracked", "--max-count=20", "-e", q).catch(() => "");
  const hits: { path: string; line: number; text: string }[] = [];
  for (const l of out.split("\n")) {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    hits.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 300) });
    if (hits.length >= 400) break;
  }
  return hits;
}

export async function stage(root: string, paths: string[], on: boolean) {
  if (on) await git(root, "add", "--", ...paths);
  else await git(root, "restore", "--staged", "--", ...paths);
}

export const commit = (root: string, message: string) => git(root, "commit", "-m", message);
export const push = (root: string) => run("git", ["-C", root, "push", "-u", "origin", "HEAD"], { timeout: 120_000 });
export const discard = (root: string, rel: string) => git(root, "checkout", "--", rel);

export const branchInfo = async (root: string) => ({
  branch: (await git(root, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
  log: (await git(root, "log", "-15", "--format=%h%x09%ct%x09%s")).trim().split("\n").filter(Boolean).map((l) => {
    const [sha, ct, subject] = l.split("\t");
    return { sha, at: Number(ct) * 1000, subject };
  }),
});

// The commit graph for the history list: parents give the lanes, refs the branch and tag labels.
export async function history(root: string, limit: number) {
  const n = String(Math.min(Math.max(limit, 1), 500));
  const out = await git(root, "log", "--date-order", `-${n}`, "--format=%H%x1f%P%x1f%ct%x1f%an%x1f%D%x1f%s%x1e", "HEAD").catch(() => "");
  return out
    .split("\x1e")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha, parents, ct, author, refs, subject] = l.split("\x1f");
      return { sha, parents: parents ? parents.split(" ") : [], at: Number(ct) * 1000, author, refs: refs ? refs.split(", ") : [], subject };
    });
}

const SHA = /^[0-9a-f]{4,40}$/;
const checkSha = (sha: string) => {
  if (!SHA.test(sha)) throw new Error("not a commit id");
  return sha;
};

// What a commit changed, against its first parent; the first commit against nothing.
export async function commitFiles(root: string, sha: string) {
  checkSha(sha);
  const [body, out] = await Promise.all([
    git(root, "show", "-s", "--format=%B", sha),
    git(root, "diff-tree", "-r", "--root", "-m", "--first-parent", "--no-commit-id", "--name-status", "-z", sha),
  ]);
  const parts = out.split("\0").filter(Boolean);
  const list: { path: string; status: string; from?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i][0];
    if (status === "R" || status === "C") {
      list.push({ status, from: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else list.push({ status, path: parts[++i] });
  }
  return { message: body.trim(), files: list };
}

// Both sides of one file in one commit, for the diff view
export async function commitFile(root: string, sha: string, rel: string, from?: string) {
  checkSha(sha);
  inside(root, rel);
  if (from) inside(root, from);
  const parent = (await git(root, "rev-list", "--parents", "-n", "1", sha)).trim().split(" ")[1];
  const at = async (rev: string | undefined, path: string) => {
    if (!rev) return { content: "", binary: false, tooLarge: false };
    const size = Number((await git(root, "cat-file", "-s", `${rev}:${path}`).catch(() => "0")).trim());
    if (size > MAX_FILE) return { content: "", binary: false, tooLarge: true };
    const buf = Buffer.from(await git(root, "show", `${rev}:${path}`).catch(() => ""), "utf8");
    const binary = buf.subarray(0, 8000).includes(0);
    return { content: binary ? "" : buf.toString("utf8"), binary, tooLarge: false };
  };
  const [before, after] = await Promise.all([at(parent, from ?? rel), at(sha, rel)]);
  return { before, after };
}

// Images pasted or files dropped on a terminal land here, in ~/.claude/pastes,
// and the terminal gets the path. Only the last 20, from the past week, are kept.
const PASTES = join(config.claude.dir, "pastes");
const MAX_PASTE = 25 * 1024 * 1024;

export async function savePaste(data: ArrayBuffer | Buffer, name: string) {
  if (data.byteLength > MAX_PASTE) throw new Error("file too large");
  await mkdir(PASTES, { recursive: true });
  const ext = (name.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? ".png").toLowerCase();
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const dest = join(PASTES, `${stamp}-${Math.floor(1000 + Math.random() * 9000)}${ext}`);
  await writeFile(dest, Buffer.isBuffer(data) ? data : Buffer.from(data));
  prunePastes().catch(() => {});
  return dest;
}

async function prunePastes() {
  const week = Date.now() - 7 * 86400_000;
  const all = await Promise.all((await readdir(PASTES)).map(async (f) => ({ f: join(PASTES, f), at: (await stat(join(PASTES, f))).mtimeMs })));
  all.sort((a, b) => b.at - a.at);
  await Promise.all(all.filter((x, i) => i >= 20 || x.at < week).map((x) => rm(x.f, { force: true })));
}

// Folders added by hand from the terminal launcher, for projects that live outside extraRoots.
export const savedFolders = () => (db.prepare("select path from folders order by added_at").all() as { path: string }[]).map((f) => f.path);

const home = homedir();
const inHome = (p: string) => p === home || p.startsWith(home + sep);
const expand = (p: string) => resolve(p.startsWith("~") ? join(home, p.slice(1)) : p);

export function saveFolder(raw: string) {
  const p = expand(raw);
  if (!inHome(p) || !existsSync(p) || !statSync(p).isDirectory()) throw new Error("not a folder in your home");
  db.prepare("insert or ignore into folders (path, added_at) values (?, ?)").run(p, Date.now());
  return p;
}

export const forgetFolder = (raw: string) => db.prepare("delete from folders where path = ?").run(expand(raw));

// A subfolder of a saved folder can host a terminal too, it needn't be a git repo
export const insideSaved = (cwd: string) => {
  const p = resolve(cwd);
  return savedFolders().some((f) => p === f || p.startsWith(f + sep));
};

// The subfolders of a path, for completing a typed path in the launcher
export async function listDirs(raw: string) {
  const p = expand(raw || "~");
  if (!inHome(p)) return { path: p, dirs: [] };
  const ents = await readdir(p, { withFileTypes: true }).catch(() => []);
  const dirs = ents
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
    .map((d) => join(p, d.name))
    .sort()
    .slice(0, 50);
  return { path: p, dirs };
}

export const projectRoots = async () => {
  const out: string[] = [];
  for (const base of config.extraRoots) {
    for (const d of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (d.isDirectory() && existsSync(join(base, d.name, ".git"))) out.push(join(base, d.name));
    }
  }
  return out;
};

// One code view operation on a root, by the name its route has: the routes call it for this machine and a node
// calls it for its hub, so both check and answer the same way. The root has been allowed already.
export async function fsCall(root: string, method: string, op: string, q: Record<string, string | undefined>, body: any = {}) {
  const get = method === "GET";
  if (get && op === "tree") return tree(root);
  if (get && op === "changes") return changes(root);
  if (get && op === "info") return branchInfo(root);
  if (get && op === "history") return history(root, Number(q.limit ?? 50));
  if (get && op === "commit") return q.path ? commitFile(root, q.sha ?? "", q.path, q.from) : commitFiles(root, q.sha ?? "");
  if (get && op === "file") return read(root, q.path!);
  if (method === "PUT" && op === "file") return { mtime: await write(root, body.path, body.content, body.mtime) };
  if (get && op === "head") return { content: await headVersion(root, q.path!) };
  if (get && op === "diff") return diff(root, q.path);
  if (get && op === "search") return search(root, q.q ?? "");
  if (method === "POST" && op === "stage") return stage(root, body.paths, body.on).then(() => ({ ok: true }));
  if (method === "POST" && op === "discard") return discard(root, body.path).then(() => ({ ok: true }));
  if (method === "POST" && op === "commit") return { out: await commit(root, body.message) };
  if (method === "POST" && op === "push") return { out: await push(root) };
  throw Object.assign(new Error(`no ${method} ${op}`), { status: 404 });
}

// what changed in the repo a terminal is in, for the panel next to it
export async function termChanges(cwd: string | undefined) {
  const root = cwd && (await gitRoot(cwd));
  if (!root || !(await allowedRoot(root))) return { root: null, cwd: cwd ?? null, changes: [] as Awaited<ReturnType<typeof changes>> };
  return { root, cwd, changes: await changes(root) };
}

// the folders a terminal may open in: a known root, home, a saved folder, or inside a repo cockpit knows
export const cwdAllowed = async (cwd: string) => (await allowedRoot(cwd)) || cwd === process.env.HOME || insideSaved(cwd) || (await allowedRoot((await gitRoot(cwd)) ?? cwd));

export const roots = async () => ({
  worktrees: (await listWorktrees(false)).map((w) => ({ path: w.path, name: w.name, branch: w.branch, ticket: w.ticket })),
  projects: await projectRoots(),
  folders: savedFolders(),
});
