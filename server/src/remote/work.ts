// The hub's view of its nodes' repos: their worktrees and the folders the code view can open, kept here from
// the last time each node answered, so a node that's down still shows what it had. A path says which machine
// it's on: anything inside one of a node's roots goes to that node, so the screens keep sending just the path.
import type { Worktree } from "@cockpit/shared";
import { mirrorChunk, mirrorJob, type Job } from "../jobs.ts";
import { listWorktrees, repoState } from "../worktrees.ts";
import { where } from "../placement/where.ts";
import type { RemoteLink } from "./link.ts";

export interface Roots {
  worktrees: { path: string; name: string; branch?: string; ticket?: string; node?: string }[];
  projects: string[];
  folders: string[];
  // a node's projects and saved folders; its worktrees are with this machine's, tagged
  remote?: { path: string; node: string; kind: "project" | "folder" }[];
}

interface Node {
  link: RemoteLink;
  repo?: string;
  worktrees: Worktree[];
  roots?: Roots;
}

const nodes = new Map<string, Node>();
const up = (n: Node) => n.link.status.state === "up";
const tag = (machine: string, w: Worktree): Worktree => ({ ...w, node: machine });

async function fetchWorktrees(machine: string, n: Node, status: boolean) {
  if (!up(n)) return n.worktrees;
  try {
    const r = await n.link.request<{ state: string; worktrees: Worktree[] }>("worktrees.list", { status }, status ? 30_000 : 10_000);
    n.repo = r.state;
    n.worktrees = r.worktrees.map((w) => tag(machine, w));
  } catch {}
  return n.worktrees;
}

async function fetchRoots(n: Node) {
  if (up(n)) n.roots = (await n.link.request<Roots>("code.roots").catch(() => undefined)) ?? n.roots;
  return n.roots;
}

export function addWorkLink(machine: string, link: RemoteLink) {
  const n: Node = { link, worktrees: nodes.get(machine)?.worktrees ?? [], roots: nodes.get(machine)?.roots };
  nodes.set(machine, n);
  link.onUp((c) => {
    // the node's jobs show here as they run: worktrees being made, checks, anything its automations start
    c.on("job.start", (j: Job) => mirrorJob(machine, j));
    c.on("job", (ev: { id: string; chunk?: string; done?: boolean; code?: number }) => mirrorChunk(ev));
    void fetchWorktrees(machine, n, false);
    void fetchRoots(n);
  });
}

export const removeWorkLink = (machine: string) => void nodes.delete(machine);

// this machine's worktrees and every node's, each node's tagged with it
export async function allWorktrees(status = false) {
  const theirs = await Promise.all([...nodes].map(([machine, n]) => fetchWorktrees(machine, n, status)));
  return [...(await listWorktrees(status)), ...theirs.flat()];
}

export async function allRoots(mine: Roots): Promise<Roots> {
  const out: Roots = { ...mine, worktrees: [...mine.worktrees], remote: [] };
  for (const [machine, n] of nodes) {
    const r = await fetchRoots(n);
    if (!r) continue;
    out.worktrees.push(...r.worktrees.map((w) => ({ ...w, node: machine })));
    out.remote!.push(...r.projects.map((path) => ({ path, node: machine, kind: "project" as const })), ...r.folders.map((path) => ({ path, node: machine, kind: "folder" as const })));
  }
  return out;
}

const within = (path: string, root: string) => path === root || path.startsWith(root + "/");

// the node a path is on, from what each node said it has; undefined is this machine
export function ownerOf(path: string) {
  if (!path) return;
  for (const [machine, n] of nodes) {
    const r = n.roots;
    const known = [...n.worktrees.map((w) => w.path), ...(r ? [...r.worktrees.map((w) => w.path), ...r.projects, ...r.folders] : [])];
    if (known.some((root) => within(path, root))) return machine;
  }
}

// the same, asking the nodes again when none claims it: a worktree made a moment ago may not be in the copy yet
export async function findOwner(path: string) {
  const known = ownerOf(path);
  if (known || !path || !nodes.size) return known;
  await Promise.all([...nodes].map(([machine, n]) => Promise.all([fetchWorktrees(machine, n, false), fetchRoots(n)])));
  return ownerOf(path);
}

// Where new worktrees are made: on the machine the automations run on when it has the repo and is connected,
// since its tasks, autopilot and checks work in them; else this machine when its repo is set up, else the first
// connected node whose is
export function repoNode(): string | undefined {
  const auto = where("automations");
  const ready = (n?: Node) => !!n && n.repo === "ok" && up(n);
  if (auto && ready(nodes.get(auto))) return auto;
  // this machine stands in while that one is away
  if (repoState() === "ok") return;
  for (const [machine, n] of nodes) if (ready(n)) return machine;
}

export function requestWork<T>(machine: string, m: string, a?: unknown, timeoutMs?: number) {
  const n = nodes.get(machine);
  if (!n) return Promise.reject(Object.assign(new Error(`No machine called ${machine}`), { status: 404 }));
  return n.link.request<T>(m, a, timeoutMs);
}

// a job the node started for this hub, listed here before its first chunk arrives
export const tracked = (machine: string, j: Job) => mirrorJob(machine, j);

export const nodesUp = () => [...nodes].filter(([, n]) => up(n)).map(([machine]) => machine);
