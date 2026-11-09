// How busy this machine is: CPU over the last stretch, memory in use and how full the disk the work lives on is.
// Sampled in the background, so the info a node hands its hub is always at hand without waiting on anything.
import { execFile } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { cpus, homedir, totalmem } from "node:os";
import { config } from "../config.ts";
import type { MachineLoad } from "./protocol.ts";

let last: MachineLoad | undefined;
let prev: { idle: number; total: number } | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

const ticks = () =>
  cpus().reduce(
    (a, c) => {
      const t = c.times;
      return { idle: a.idle + t.idle, total: a.total + t.idle + t.user + t.nice + t.sys + t.irq };
    },
    { idle: 0, total: 0 },
  );

// the share of the CPU used since the last sample, all cores together
function cpuSince() {
  const now = ticks();
  const was = prev;
  prev = now;
  if (!was || now.total <= was.total) return undefined;
  return Math.round(100 * (1 - (now.idle - was.idle) / (now.total - was.total)));
}

// what macOS can hand out right away: free, plus what it keeps only as cache (inactive, speculative, purgeable).
// os.freemem() counts free pages alone, which makes any Mac look full.
const macAvailable = () =>
  new Promise<number | undefined>((ok) =>
    execFile("vm_stat", { timeout: 3000 }, (err, out) => {
      if (err) return ok(undefined);
      const size = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
      const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      ok((pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * size);
    }),
  );

// Linux's MemAvailable, which counts reclaimable cache as free
const linuxAvailable = async () => {
  const { readFile } = await import("node:fs/promises");
  const kb = /MemAvailable:\s+(\d+)/.exec(await readFile("/proc/meminfo", "utf8").catch(() => ""))?.[1];
  return kb ? Number(kb) * 1024 : undefined;
};

// the disk the repo and its worktrees are on, or home without one
function disk() {
  const at = config.repo.path && existsSync(config.repo.path) ? config.repo.path : homedir();
  try {
    const s = statfsSync(at);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return undefined;
  }
}

async function sample() {
  const total = totalmem();
  const available = process.platform === "darwin" ? await macAvailable() : process.platform === "linux" ? await linuxAvailable() : undefined;
  const d = disk();
  last = {
    cpu: cpuSince() ?? last?.cpu,
    memUsed: available === undefined ? undefined : Math.max(0, total - available),
    memTotal: total,
    diskFree: d?.free,
    diskTotal: d?.total,
    at: Date.now(),
  };
}

export function machineLoad(): MachineLoad | undefined {
  if (!timer) {
    void sample();
    timer = setInterval(() => void sample(), 15_000);
    timer.unref?.();
  }
  return last;
}
