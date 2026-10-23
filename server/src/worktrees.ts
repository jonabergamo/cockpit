import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Worktree } from "@cockpit/shared";
import { config } from "./config.ts";
import { cached, db } from "./db.ts";
import { startJob } from "./jobs.ts";
import { emit } from "./events.ts";
import { rememberTemplate, type WorkTemplate } from "./templates.ts";
import { fill, run, slugify, ticketOf } from "./util.ts";

const repo = config.repo;
const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, ...args], { timeout: 30_000 });

function parsePorcelain(out: string) {
  const list: { path: string; head: string; branch?: string }[] = [];
  for (const block of out.trim().split("\n\n")) {
    const wt: any = {};
    for (const line of block.split("\n")) {
      const [k, ...rest] = line.split(" ");
      const v = rest.join(" ");
      if (k === "worktree") wt.path = v;
      if (k === "HEAD") wt.head = v;
      if (k === "branch") wt.branch = v.replace("refs/heads/", "");
    }
    if (wt.path) list.push(wt);
  }
  return list;
}

const linkFor = db.prepare<[string], { ticket: string }>("select ticket from links where worktree = ?");

function nameOf(path: string) {
  if (path.startsWith(repo.worktreesDir + "/")) return path.slice(repo.worktreesDir.length + 1).split("/")[0];
  return basename(path);
}

async function status(path: string) {
  const [st, log] = await Promise.all([
    git(path, "status", "--porcelain=v2", "--branch").catch(() => ""),
    git(path, "log", "-1", "--format=%ct%x09%s").catch(() => ""),
  ]);
  const ab = st.match(/^# branch\.ab \+(\d+) -(\d+)/m);
  const dirty = st.split("\n").filter((l) => l && !l.startsWith("#")).length;
  const [ct, subject] = log.trim().split("\t");
  return {
    dirty,
    ahead: ab ? Number(ab[1]) : undefined,
    behind: ab ? Number(ab[2]) : undefined,
    lastCommitAt: ct ? Number(ct) * 1000 : undefined,
    lastCommitSubject: subject,
  };
}

export const sizeOf = (path: string) =>
  cached(`du:${path}`, 6 * 3600_000, async () => Number((await run("du", ["-sb", path], { timeout: 300_000 }).catch(() => "0")).split("\t")[0]));

// whether repo.path points at a git checkout; until it does there are no worktrees, and the Board says how to set it
export function repoState(): "unset" | "missing" | "not-git" | "ok" {
  if (!repo.path) return "unset";
  if (!existsSync(repo.path)) return "missing";
  return existsSync(join(repo.path, ".git")) ? "ok" : "not-git";
}

export async function listWorktrees(withStatus = true): Promise<Worktree[]> {
  if (repoState() !== "ok") return [];
  const raw = parsePorcelain(await git(repo.path, "worktree", "list", "--porcelain"));
  const sizes = db.prepare<[string], { value: string }>("select value from cache where key = ?");

  return Promise.all(
    raw.map(async (w, i) => {
      const name = nameOf(w.path);
      const size = sizes.get(`du:${w.path}`);
      const wt: Worktree = {
        path: w.path,
        name,
        branch: w.branch,
        head: w.head?.slice(0, 10) ?? "",
        main: i === 0,
        // the folder first: an epic worktree keeps its name while it checks out each stacked ticket's branch
        ticket: linkFor.get(w.path)?.ticket ?? ticketOf(name, w.branch),
        sizeBytes: size ? Number(JSON.parse(size.value)) : undefined,
      };
      return withStatus && existsSync(w.path) ? { ...wt, ...(await status(w.path)) } : wt;
    }),
  );
}

// du over ~40 worktrees takes a while, so it runs one at a time in the background.
let sizing = false;
export async function refreshSizes() {
  if (sizing) return;
  sizing = true;
  try {
    for (const w of await listWorktrees(false)) if (!w.main) await sizeOf(w.path);
  } finally {
    sizing = false;
  }
}

export function link(ticket: string, worktree: string) {
  db.prepare("insert or replace into links (ticket, worktree) values (?, ?)").run(ticket, worktree);
}

export function unlink(ticket: string, worktree: string) {
  db.prepare("delete from links where ticket = ? and worktree = ?").run(ticket, worktree);
}

// `ticket` is what the worktree belongs to when the folder key isn't the ticket itself, like a second attempt
export function createWorktree(key: string, summary: string, opts: { ticket?: string; template?: WorkTemplate; onDone?: (ok: boolean, path: string, branch: string, output: string) => void } = {}) {
  const slug = slugify(summary) || "work";
  const branch = fill(repo.branchTemplate, { key, slug });
  const tpl = opts.template;
  const command = fill(repo.createCommand, {
    ...tpl?.vars,
    repo: repo.path,
    worktreesDir: repo.worktreesDir,
    key,
    slug,
    branch,
    name: repo.name,
  });
  // a placeholder nothing filled would reach the shell as text
  const unfilled = command.match(/\{(\w+)\}/)?.[1];
  if (unfilled) throw Object.assign(new Error(`repo.createCommand uses {${unfilled}}, which ${tpl ? `the "${tpl.name}" kind of work doesn't set` : "no kind of work matched to set"}. Set it in Settings → Kinds of work.`), { status: 400 });
  const path = join(repo.worktreesDir, key, repo.name);
  return startJob(`create ${key}`, command, repo.path, (job) => {
    opts.onDone?.(job.code === 0, path, branch, job.output);
    if (job.code !== 0) return;
    if (opts.ticket !== "") link(opts.ticket ?? key, path);
    if (tpl) rememberTemplate(path, tpl.id);
    emit("worktree.created", { key, path, branch, template: tpl?.id, autopilot: tpl?.autopilot });
  });
}

// what's left behind once a worktree folder is gone
function forget(path: string) {
  emit("worktree.removed", { path });
  db.prepare("delete from links where worktree = ?").run(path);
  db.prepare("delete from cache where key = ?").run(`du:${path}`);
  // claude keeps <name>.status / .tracked.diff next to its worktrees
  const base = join(repo.worktreesDir, nameOf(path));
  if (dirname(path) === base) run("rm", ["-f", `${base}.status`, `${base}.tracked.diff`]).catch(() => {});
}

// Removes a worktree's parent folder once the worktree is gone, along with the editor workspace files some
// setups keep there. Anything else in it keeps the folder.
export function tidyParent(parent: string) {
  const q = JSON.stringify(parent);
  return `[ -d ${q} ] && [ -z "$(find ${q} -mindepth 1 -maxdepth 1 ! -name '*.code-workspace')" ] && rm -f ${q}/*.code-workspace ; rmdir ${q} 2>/dev/null`;
}

// The delete command, then a way past files Docker containers left behind as root: those can only be removed
// from inside a container, so mount just this worktree and empty it there. The parent folder goes too when
// nothing but workspace files is left in it.
export function removeStep(path: string, leftover = false) {
  const q = JSON.stringify(path);
  const del = leftover ? `rm -rf ${q}` : fill(repo.deleteCommand, { repo: repo.path, path, name: nameOf(path) });
  const docker = `command -v docker >/dev/null && echo "some files belong to docker containers, removing them through docker" && docker run --rm -v ${q}:/w alpine:3.22 find /w -mindepth 1 -delete && rmdir ${q}`;
  const parent = join(repo.worktreesDir, nameOf(path));
  const tidy = dirname(path) === parent ? ` ; ${tidyParent(parent)}` : "";
  return `echo "removing ${nameOf(path)}" && ( (${del}) || (${docker}) || echo "could not remove ${nameOf(path)}" )${tidy}`;
}

const prune = () => `git -C ${JSON.stringify(repo.path)} worktree prune -v`;

export function deleteWorktree(path: string) {
  return startJob(`delete ${nameOf(path)}`, `${removeStep(path)} ; ${prune()}`, repo.path, () => {
    if (!existsSync(path)) forget(path);
  });
}

// Several at once, one after the other in a single job; a failure doesn't stop the rest. Folders that are
// already gone are pruned from git's list at the end.
export function deleteWorktrees(paths: string[], leftovers: string[] = []) {
  const steps = [...paths.map((p) => removeStep(p)), ...leftovers.map((p) => removeStep(p, true)), prune()];
  return startJob(`clean up ${paths.length + leftovers.length} worktrees`, steps.join(" ; "), repo.path, () => {
    for (const path of paths) if (!existsSync(path)) forget(path);
  });
}

// Folders in the worktrees directory that git no longer knows about: what a half-failed removal or a manual
// `git worktree prune` leaves behind.
export async function leftoverFolders() {
  if (!repo.worktreesDir || !existsSync(repo.worktreesDir)) return [];
  const known = (await listWorktrees(false)).map((w) => w.path);
  const dirs = readdirSync(repo.worktreesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(repo.worktreesDir, d.name));
  return dirs.filter((d) => !known.some((k) => k === d || k.startsWith(d + "/")));
}

export function openInEditor(path: string) {
  return startJob(`open ${nameOf(path)}`, fill(repo.openCommand, { path, repo: repo.path, name: nameOf(path) }));
}

export const isWorktree = async (path: string) => (await listWorktrees(false)).some((w) => w.path === path);
