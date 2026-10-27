// claude -p, on whichever machine Settings → Machines puts it: this one by default, or a node. The prompt goes
// through a file, since it's often too long to be an argument, and the job's output is Claude's answer.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings } from "../settings.ts";
import { config, paths } from "../config.ts";
import { startJob, whenDone, type Job } from "../jobs.ts";
import { fill } from "../util.ts";
import { agentBin, mainAgent } from "../workers/index.ts";
import { requestWork, tracked } from "../remote/work.ts";
import { where } from "./where.ts";

export interface Headless {
  label: string;
  prompt: string;
  model?: string;
  // the folder it runs in; the repo by default, since Claude asks to trust a folder first and the home folder
  // usually isn't trusted
  cwd?: string;
  // short and wanted fast: the local model answers, when Settings → Automation names one
  quick?: boolean;
  // the model that does, filled in by the machine that asked so the one that runs it needn't know
  local?: { url: string; model: string };
}

const ollama = join(dirname(fileURLToPath(import.meta.url)), "ollama.mjs");

// on this machine, whatever placement says
export function headlessHere(h: Headless, onDone?: (job: Job) => void) {
  const file = join(paths.data, `claude-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
  writeFileSync(file, h.prompt, { mode: 0o600 });
  const q = JSON.stringify(file);
  // the main agent answers; a model named here is Claude's, so another agent uses its own default
  const main = mainAgent();
  if (h.local) {
    const cmd = [process.execPath, ollama, h.local.url, h.local.model].map((a) => JSON.stringify(a)).join(" ");
    return startJob(h.label, `${cmd} < ${q}; code=$?; rm -f ${q}; exit $code`, h.cwd ?? process.env.HOME, onDone);
  }
  const cmd = main?.ask
    ? [agentBin(main), ...main.ask()].map((a) => (/^[\w./:@=,+-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")
    : `${fill("{bin}", { bin: config.claude.bin })} -p${h.model ? ` --model ${JSON.stringify(h.model)}` : ""}`;
  // what Codex prints along the way goes to stderr, which the job would show as part of the answer
  return startJob(h.label, `${cmd} < ${q}${main?.ask ? " 2>/dev/null" : ""}; code=$?; rm -f ${q}; exit $code`, h.cwd ?? (config.repo.path || process.env.HOME), onDone);
}

// node is where to run it when the caller knows, like a folder that's on that node
export async function headless(h: Headless, onDone?: (job: Job) => void, node?: string): Promise<Job> {
  const q = getSettings().quick;
  if (h.quick && q.model) {
    h = { ...h, local: { url: q.url, model: q.model } };
    node ??= where("quick");
  } else node ??= where("headless");
  if (!node) return headlessHere(h, onDone);
  // a folder is only passed on when it's the node's; without one the node uses its own repo
  const job = tracked(node, await requestWork<Job>(node, "job.headless", h));
  if (onDone) whenDone(job.id, onDone);
  return job;
}
