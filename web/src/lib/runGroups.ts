import type { Run, RunStatus } from "@cockpit/shared";

// How the Runs list is cut up: by what a run was for, by day, by kind, or not at all
export type GroupBy = "ticket" | "day" | "kind" | "none";
export const GROUP_BYS: GroupBy[] = ["ticket", "day", "kind", "none"];

export interface RunGroup {
  key: string;
  label: string;
  ticket?: string;
  rows: RunRow[];
  // the PRs its runs ran against, newest first
  prs: { number: number; url?: string }[];
  latestAt: number;
  running: number;
  // rows whose latest result is a failure
  failing: number;
}

export type RunRow =
  | { type: "single"; run: Run }
  // the same flow or command in the same place, newest first: the latest shows, the rest open under it
  | { type: "repeat"; run: Run; earlier: Run[] }
  // every check GitHub ran on one commit
  | { type: "ci"; sha: string; pr?: number; checks: Run[]; latest: Run };

const worst = (list: Run[]): RunStatus =>
  list.some((r) => r.status === "fail") ? "fail" : list.some((r) => r.status === "running") ? "running" : list.some((r) => r.status === "cancelled") ? "cancelled" : "pass";
export const rowStatus = (row: RunRow): RunStatus => (row.type === "ci" ? worst(row.checks) : row.run.status);
// the PR a run ran against, from the branch it was on
export const prOf = (r: Run) => (typeof r.meta.pr === "number" ? r.meta.pr : undefined);
export const rowPr = (row: RunRow) => (row.type === "ci" ? row.pr : prOf(row.run));
const rowAt = (row: RunRow) => (row.type === "ci" ? row.latest.startedAt : row.run.startedAt);

const lastPart = (p: string) => p.replace(/\/+$/, "").split("/").filter(Boolean).slice(-1)[0] ?? p;

// A run with no ticket and no worktree goes under the folder it ran in, folded into the shallowest folder above it
// that another run used, so a repo and its subfolders are one group
function folders(runs: Run[]) {
  const dirs = [...new Set(runs.filter((r) => !r.ticket && !r.worktree && r.cwd).map((r) => r.cwd!.replace(/\/+$/, "")))].sort((a, b) => a.length - b.length);
  const top = new Map<string, string>();
  for (const d of dirs) top.set(d, dirs.find((up) => d === up || d.startsWith(`${up}/`)) ?? d);
  return top;
}

function ticketKey(r: Run, top: Map<string, string>, worktreeName: (path: string) => string): { key: string; label: string; ticket?: string } {
  if (r.ticket) return { key: `t:${r.ticket}`, label: r.ticket, ticket: r.ticket };
  // a worktree can hold a stack of PRs, so the PR says more than the worktree
  const pr = prOf(r);
  if (pr) return { key: `p:${pr}`, label: `PR #${pr}` };
  if (r.worktree) return { key: `w:${r.worktree}`, label: `No ticket · ${worktreeName(r.worktree)}` };
  if (r.cwd) {
    const dir = top.get(r.cwd.replace(/\/+$/, "")) ?? r.cwd;
    return { key: `d:${dir}`, label: `No ticket · ${lastPart(dir)}` };
  }
  return { key: "none", label: "No ticket" };
}

function dayKey(r: Run, now: number) {
  const day = (t: number) => new Date(t).toDateString();
  const d = day(r.startedAt);
  const label = d === day(now) ? "Today" : d === day(now - 864e5) ? "Yesterday" : new Date(r.startedAt).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  return { key: `day:${d}`, label };
}

// Repeats of one run and the checks of one commit, each as a single row; runs come newest first and stay that way
export function collapse(runs: Run[]): RunRow[] {
  const rows: RunRow[] = [];
  const byRun = new Map<string, Extract<RunRow, { type: "repeat" }>>();
  const bySha = new Map<string, Extract<RunRow, { type: "ci" }>>();
  for (const r of runs) {
    const sha = r.kind === "ci" && typeof r.meta.sha === "string" ? r.meta.sha : undefined;
    if (sha) {
      const had = bySha.get(sha);
      if (had) had.checks.push(r);
      else {
        const row: RunRow = { type: "ci", sha, pr: typeof r.meta.pr === "number" ? r.meta.pr : undefined, checks: [r], latest: r };
        bySha.set(sha, row);
        rows.push(row);
      }
      continue;
    }
    // the same flow on two PRs of one worktree is two rows
    const key = `${r.kind}|${r.name}|${r.worktree ?? r.cwd ?? ""}|${prOf(r) ?? ""}`;
    const had = byRun.get(key);
    if (had) {
      had.earlier.push(r);
      continue;
    }
    const row: Extract<RunRow, { type: "repeat" }> = { type: "repeat", run: r, earlier: [] };
    byRun.set(key, row);
    rows.push(row);
  }
  return rows.map((row) => (row.type === "repeat" && !row.earlier.length ? { type: "single", run: row.run } : row));
}

const KIND_ORDER = ["e2e", "proof", "unit", "lint", "typecheck", "audit", "verify", "ci", "other"];

// worktreeName gives a worktree its name as cockpit lists it (its folder's last part is often just the repo's name)
export function groupRuns(runs: Run[], by: GroupBy, kindLabel: (k: string) => string, worktreeName: (path: string) => string = lastPart, now = Date.now()): RunGroup[] {
  if (by === "none") return [];
  const top = folders(runs);
  const groups = new Map<string, { key: string; label: string; ticket?: string; runs: Run[] }>();
  for (const r of runs) {
    const g = by === "ticket" ? ticketKey(r, top, worktreeName) : by === "day" ? dayKey(r, now) : { key: `k:${r.kind}`, label: kindLabel(r.kind) };
    const had = groups.get(g.key);
    if (had) had.runs.push(r);
    else groups.set(g.key, { ...g, runs: [r] });
  }
  const out = [...groups.values()].map((g) => {
    const rows = collapse(g.runs);
    const prs = new Map<number, string | undefined>();
    for (const r of g.runs) {
      const n = prOf(r);
      if (n && !prs.has(n)) prs.set(n, typeof r.meta.prUrl === "string" ? r.meta.prUrl : undefined);
    }
    return {
      key: g.key,
      label: g.label,
      ticket: g.ticket,
      rows,
      prs: [...prs].map(([number, url]) => ({ number, url })),
      latestAt: Math.max(...rows.map(rowAt)),
      running: g.runs.filter((r) => r.status === "running").length,
      failing: rows.filter((row) => rowStatus(row) === "fail").length,
    };
  });
  if (by === "kind") return out.sort((a, b) => KIND_ORDER.indexOf(a.key.slice(2)) - KIND_ORDER.indexOf(b.key.slice(2)));
  // what's going on now first, then the most recently active
  return out.sort((a, b) => (by === "ticket" ? Number(b.running > 0) - Number(a.running > 0) : 0) || b.latestAt - a.latestAt);
}
