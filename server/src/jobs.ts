import { randomUUID } from "node:crypto";
import { broadcast } from "./hub.ts";
import { stream } from "./util.ts";

export interface Job {
  id: string;
  label: string;
  command: string;
  startedAt: number;
  output: string;
  code?: number;
  // the machine it runs on, when that's a node
  node?: string;
}

const jobs = new Map<string, Job>();
const starters = new Set<(job: Job) => void>();

// every job as it starts, for a node to tell its hub about
export const onJobStart = (fn: (job: Job) => void) => (starters.add(fn), () => void starters.delete(fn));

// Long-running shell commands (worktree create/delete, open in editor) stream to every client.
export function startJob(label: string, command: string, cwd?: string, onDone?: (job: Job) => void) {
  const job: Job = { id: randomUUID(), label, command, startedAt: Date.now(), output: "" };
  jobs.set(job.id, job);
  for (const fn of starters) fn(job);

  stream(
    command,
    (chunk) => {
      job.output += chunk;
      broadcast({ type: "job", id: job.id, chunk });
    },
    cwd,
  ).then(({ code }) => {
    job.code = code;
    broadcast({ type: "job", id: job.id, done: true, code });
    onDone?.(job);
  });

  return job;
}

export const listJobs = () => [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30);
export const getJob = (id: string) => jobs.get(id);

// A node's job, followed here from what it sends: its start, then the same chunks and end the node's own
// clients get, passed on to this one's
export function mirrorJob(node: string, j: Job) {
  if (!jobs.has(j.id)) jobs.set(j.id, { ...j, node });
  return jobs.get(j.id)!;
}

// what to do once a node's job ends, like saving what Claude wrote
const after = new Map<string, (job: Job) => void>();
export function whenDone(id: string, fn: (job: Job) => void) {
  const job = jobs.get(id);
  if (job?.code !== undefined) return fn(job);
  after.set(id, fn);
}

export function mirrorChunk(ev: { id: string; chunk?: string; done?: boolean; code?: number }) {
  const job = jobs.get(ev.id);
  if (!job) return;
  if (ev.chunk) job.output += ev.chunk;
  if (ev.done) {
    job.code = ev.code;
    after.get(ev.id)?.(job);
    after.delete(ev.id);
  }
  broadcast({ type: "job", id: ev.id, chunk: ev.chunk, done: ev.done, code: ev.code });
}
