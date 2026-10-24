// claude -p, on whichever machine Settings → Machines puts it: this one by default, or a node. The prompt goes
// through a file, since it's often too long to be an argument, and the job's output is Claude's answer.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, paths } from "../config.ts";
import { startJob, whenDone, type Job } from "../jobs.ts";
import { fill } from "../util.ts";
import { requestWork, tracked } from "../remote/work.ts";
import { where } from "./where.ts";

export interface Headless {
  label: string;
  prompt: string;
  model?: string;
  // the folder it runs in; the repo by default, since Claude asks to trust a folder first and the home folder
  // usually isn't trusted
  cwd?: string;
}

// on this machine, whatever placement says
export function headlessHere(h: Headless, onDone?: (job: Job) => void) {
  const file = join(paths.data, `claude-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
  writeFileSync(file, h.prompt, { mode: 0o600 });
  const q = JSON.stringify(file);
  const model = h.model ? ` --model ${JSON.stringify(h.model)}` : "";
  return startJob(h.label, `${fill("{bin}", { bin: config.claude.bin })} -p${model} < ${q}; code=$?; rm -f ${q}; exit $code`, h.cwd ?? (config.repo.path || process.env.HOME), onDone);
}

// node is where to run it when the caller knows, like a folder that's on that node
export async function headless(h: Headless, onDone?: (job: Job) => void, node = where("headless")): Promise<Job> {
  if (!node) return headlessHere(h, onDone);
  // a folder is only passed on when it's the node's; without one the node uses its own repo
  const job = tracked(node, await requestWork<Job>(node, "job.headless", h));
  if (onDone) whenDone(job.id, onDone);
  return job;
}
