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
import { restoreTerms } from "./pty.ts";
import { startSnapshots } from "./report.ts";
import { startRecordings } from "./record.ts";
import { startRuns } from "./runs.ts";
import { startStacked } from "./stacked.ts";
import { startStuckWatch } from "./stuck.ts";
import { startTasks } from "./tasks.ts";
import { startUsage } from "./usage.ts";
import { startVerify } from "./verify.ts";
import { startWeekly } from "./weekly.ts";

// what belongs to the machine itself: its Claude sessions, their usage and search index, runs and terminals
export function startHostServices() {
  startAgentRunner();
  startSessions();
  startUsage();
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
}
