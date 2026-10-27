// What a cockpit process starts, grouped by what it's for. A single machine starts all three. Once cockpit can
// span machines, a node starts the host services and the automations, and a hub the hub services.
import { startBadges } from "./badges.ts";
import { startBudgetWatch } from "./budget.ts";
import { startAutopilot } from "./autopilot.ts";
import { startSearch } from "./claude/search.ts";
import { startSessions } from "./claude/sessions.ts";
import { startAgentRunner } from "./workers/runner.ts";
import { startLeadWatch } from "./lead.ts";
import { startOvernight } from "./overnight.ts";
import { startSnapshots } from "./report.ts";
import { startRecordings } from "./record.ts";
import { listRuns, startRuns } from "./runs.ts";
import { startStacked } from "./stacked.ts";
import { startStuckWatch } from "./stuck.ts";
import { startTasks } from "./tasks.ts";
import { startUsage } from "./usage.ts";
import { startCodexUsage } from "./codexUsage.ts";
import { startVerify } from "./verify.ts";
import { startWeekly } from "./weekly.ts";
import { board } from "./board.ts";
import { tracked, nodesUp, requestWork } from "./remote/work.ts";
import { startUpdates, useBusyCheck, useNodeUpdates } from "./update.ts";
import { listJobs, type Job } from "./jobs.ts";
import { hasTmux, restoreTerms } from "./pty.ts";

// what belongs to the machine itself: its Claude sessions, their usage and search index, runs and terminals
export function startHostServices() {
  startAgentRunner();
  startSessions();
  startUsage();
  startCodexUsage();
  startSearch();
  startRuns();
  startRecordings();
  const restored = restoreTerms();
  if (restored) console.log(`reattached ${restored} terminals`);
}

// what acts on its own and has to keep going while nobody's looking
export function startAutomations() {
  startStuckWatch();
  startBudgetWatch();
  startLeadWatch();
  startVerify();
  startAutopilot();
  startStacked();
  startOvernight();
  startTasks();
}

// what's about you and the screens: tracker snapshots, the weekly digest and the sidebar badges
export function startHubServices() {
  startSnapshots();
  startWeekly();
  startBadges();
  // updates: the nodes go first, in the same go, and nothing updates while work is going on anywhere
  useNodeUpdates(async () =>
    Promise.all(
      nodesUp().map((node) =>
        requestWork<Job>(node, "update.apply", {}, 60_000).then(
          (j) => (tracked(node, j), `${node} is updating too (its own job shows how it goes).`),
          (e: Error) => `${node} didn't update: ${e.message}`,
        ),
      ),
    ),
  );
  // only what a restart would cut short: a session in a terminal carries on in tmux and a queued task starts after
  useBusyCheck(async () => {
    if (listJobs().some((j) => j.code === undefined)) return true;
    if (listRuns({ status: "running", since: Date.now() - 3 * 3600_000, limit: 1 }).length) return true;
    return (await board().catch(() => [])).some(
      (c) => c.column === "working" && (c.task?.status === "starting" || !c.session?.term || !hasTmux),
    );
  });
  startUpdates();
}
