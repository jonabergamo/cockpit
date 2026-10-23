// Shells Claude left running in the background, counted. Claude Code marks such a session "shell" in its registry
// but doesn't say how many, and older versions just say "idle". Claude's Bash tool starts every shell as its own
// child, sourcing a snapshot from ~/.claude/shell-snapshots, which is what gets counted here.
import { readdir, readFile } from "node:fs/promises";
import { run } from "../util.ts";

// the parent pid from /proc/<pid>/stat; the command name can hold spaces and brackets, so count from the last ")"
export function ppidOf(stat: string) {
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(rest[1]);
}

export const isClaudeShell = (cmdline: string) => /\.claude\/shell-snapshots\/snapshot-/.test(cmdline);

// how many of Claude's shells each of these pids has, from a list of processes
export function countShells(procs: { pid: number; ppid: number; cmdline: string }[], parents: Set<number>) {
  const out = new Map<number, number>();
  for (const p of procs) if (parents.has(p.ppid) && isClaudeShell(p.cmdline)) out.set(p.ppid, (out.get(p.ppid) ?? 0) + 1);
  return out;
}

// `ps -A -o pid=,ppid=,command=` lines: "  412   1 /bin/bash -c source ..."
export function parsePs(out: string) {
  return out
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmdline: m[3] }));
}

// /proc on Linux; macOS and the BSDs have no /proc, so they ask ps
export async function backgroundShells(parents: Set<number>) {
  if (!parents.size) return new Map<number, number>();
  if (process.platform !== "linux") return countShells(parsePs(await run("ps", ["-A", "-o", "pid=,ppid=,command="], { timeout: 5000 }).catch(() => "")), parents);
  const pids = (await readdir("/proc").catch(() => [] as string[])).filter((d) => /^\d+$/.test(d));
  const procs = await Promise.all(
    pids.map(async (d) => {
      const ppid = ppidOf(await readFile(`/proc/${d}/stat`, "utf8").catch(() => ""));
      // only a child of a Claude process is worth reading the command line of
      const cmdline = parents.has(ppid) ? (await readFile(`/proc/${d}/cmdline`, "utf8").catch(() => "")).replace(/\0/g, " ") : "";
      return { pid: Number(d), ppid, cmdline };
    }),
  );
  return countShells(procs, parents);
}
