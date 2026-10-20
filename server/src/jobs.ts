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
}

const jobs = new Map<string, Job>();

// Long-running shell commands (worktree create/delete, open in editor) stream to every client.
export function startJob(label: string, command: string, cwd?: string, onDone?: (job: Job) => void) {
  const job: Job = { id: randomUUID(), label, command, startedAt: Date.now(), output: "" };
  jobs.set(job.id, job);

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
