import { Navigate, useSearch } from "@tanstack/react-router";
import { ScreenTabs } from "../components/ScreenTabs";
import { Loading } from "../components/ui";
import { useAppConfig } from "../lib/queries";
import { ReportPage } from "./Report";
import { SessionsPage } from "./Sessions";
import { TicketsPage } from "./Tickets";
import { UsagePage } from "./Usage";
import { WeeklyPage } from "./Weekly";
import { WorkflowsPage } from "./Workflows";
import { WorktreesPage } from "./Worktrees";

// Screens that used to stand alone, shown as tabs of the one they belong with. Each page stays as it was.

export function TicketsScreen() {
  const { tab } = useSearch({ from: "/tickets" });
  const cfg = useAppConfig();
  if (cfg.isLoading) return <Loading />;
  // without a tracker there are no tickets to list, only worktrees
  const current = tab === "worktrees" || !cfg.data?.tracker ? "worktrees" : "tickets";
  return (
    <>
      <ScreenTabs screen="/tickets" current={current} />
      {current === "worktrees" ? <WorktreesPage /> : <TicketsPage />}
    </>
  );
}

export function SessionsScreen() {
  const { tab } = useSearch({ from: "/sessions" });
  const current = tab === "workflows" ? "workflows" : "sessions";
  return (
    <>
      <ScreenTabs screen="/sessions" current={current} />
      {current === "workflows" ? <WorkflowsPage /> : <SessionsPage />}
    </>
  );
}

export function ReportScreen() {
  const cfg = useAppConfig();
  if (cfg.isLoading) return <Loading />;
  // the sprint report needs a tracker; the week doesn't
  if (!cfg.data?.tracker) return <Navigate to="/weekly" search={{ week: undefined }} replace />;
  return (
    <>
      <ScreenTabs screen="/report" current="sprint" />
      <ReportPage />
    </>
  );
}

export function WeekScreen() {
  return (
    <>
      <ScreenTabs screen="/report" current="week" />
      <WeeklyPage />
    </>
  );
}

export function UsageScreen() {
  return (
    <>
      <ScreenTabs screen="/report" current="usage" />
      <UsagePage />
    </>
  );
}
