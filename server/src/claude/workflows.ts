import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowAgent, WorkflowRun } from "@cockpit/shared";
import { projectsDir } from "./sessions.ts";
import { readTail } from "./transcript.ts";

interface RunDirs {
  runId: string;
  sessionId: string;
  project: string;
  summaryFile?: string;
  journalDir?: string;
}

async function ls(dir: string) {
  return readdir(dir).catch(() => [] as string[]);
}

async function findRuns() {
  const runs = new Map<string, RunDirs>();
  for (const project of await ls(projectsDir)) {
    for (const sessionId of await ls(join(projectsDir, project))) {
      if (sessionId.includes(".")) continue;
      const base = join(projectsDir, project, sessionId);
      for (const f of await ls(join(base, "workflows"))) {
        if (!f.startsWith("wf_") || !f.endsWith(".json")) continue;
        const runId = f.slice(0, -5);
        runs.set(runId, { ...runs.get(runId), runId, sessionId, project, summaryFile: join(base, "workflows", f) });
      }
      for (const d of await ls(join(base, "subagents", "workflows"))) {
        if (!d.startsWith("wf_")) continue;
        runs.set(d, { ...runs.get(d), runId: d, sessionId, project, journalDir: join(base, "subagents", "workflows", d) });
      }
    }
  }
  return [...runs.values()];
}

async function lastTool(file: string) {
  const tail = await readTail(file, 64 * 1024).catch(() => undefined);
  for (const line of (tail?.lines ?? []).reverse()) {
    if (!line.includes('"tool_use"')) continue;
    try {
      const d = JSON.parse(line);
      const t = d.message?.content?.find((b: any) => b.type === "tool_use");
      if (t) {
        const input = t.input ?? {};
        return { name: t.name as string, summary: String(input.description ?? input.command ?? input.file_path ?? input.pattern ?? "").slice(0, 140) };
      }
    } catch {}
  }
}

// While a run is going, the summary json doesn't exist yet, so rebuild it from the journal and agent files.
async function fromJournal(dir: string): Promise<{ agents: WorkflowAgent[]; done: boolean; started?: number }> {
  const journal = await readFile(join(dir, "journal.jsonl"), "utf8").catch(() => "");
  const agents = new Map<string, WorkflowAgent>();
  for (const line of journal.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "started") agents.set(e.key, { key: e.key, label: e.label, agentId: e.agentId, phase: e.phase, state: "running" });
      if (e.type === "result") {
        const a = agents.get(e.key);
        if (a) {
          a.state = "done";
          a.resultPreview = typeof e.result === "string" ? e.result.slice(0, 400) : JSON.stringify(e.result ?? null).slice(0, 400);
        }
      }
    } catch {}
  }

  for (const a of agents.values()) {
    if (!a.agentId) continue;
    const file = join(dir, `agent-${a.agentId}.jsonl`);
    const meta = await readFile(join(dir, `agent-${a.agentId}.meta.json`), "utf8").then(JSON.parse).catch(() => ({}));
    a.model = meta.model;
    if (a.state === "running") {
      const t = await lastTool(file);
      a.lastToolName = t?.name;
      a.lastToolSummary = t?.summary;
    }
  }

  const s = await stat(join(dir, "journal.jsonl")).catch(() => undefined);
  return { agents: [...agents.values()], done: false, started: s?.birthtimeMs || s?.ctimeMs };
}

function agentsFromProgress(progress: any[] = []): WorkflowAgent[] {
  return progress
    .filter((p) => p.type === "workflow_agent")
    .map((p) => ({
      label: p.label,
      agentId: p.agentId,
      phase: p.phaseTitle,
      state: p.state,
      model: p.model,
      lastToolName: p.lastToolName,
      lastToolSummary: p.lastToolSummary,
      tokens: p.tokens,
      toolCalls: p.toolCalls,
      durationMs: p.durationMs,
      resultPreview: p.resultPreview,
    }));
}

async function load(r: RunDirs): Promise<WorkflowRun> {
  if (r.summaryFile) {
    const d = JSON.parse(await readFile(r.summaryFile, "utf8"));
    return {
      runId: r.runId,
      sessionId: r.sessionId,
      project: r.project,
      name: d.workflowName ?? r.runId,
      status: d.status ?? "completed",
      startTime: d.startTime,
      durationMs: d.durationMs,
      summary: d.summary,
      phases: d.phases ?? [],
      agents: agentsFromProgress(d.workflowProgress),
      agentCount: d.agentCount,
      totalTokens: d.totalTokens,
      scriptPath: d.scriptPath,
      live: false,
    };
  }

  const j = await fromJournal(r.journalDir!);
  const scripts = join(projectsDir, r.project, r.sessionId, "workflows", "scripts");
  const script = (await ls(scripts)).find((f) => f.includes(r.runId));
  const scriptPath = script ? join(scripts, script) : undefined;
  const src = scriptPath ? await readFile(scriptPath, "utf8").catch(() => "") : "";
  const name = src.match(/name:\s*['"]([^'"]+)/)?.[1] ?? r.runId;
  const phases = [...src.matchAll(/\{\s*title:\s*['"]([^'"]+)['"](?:,\s*detail:\s*['"]([^'"]+)['"])?/g)].map((m) => ({ title: m[1], detail: m[2] }));

  // a run without a summary whose journal stopped moving a while ago was interrupted
  const journalAge = Date.now() - ((await stat(join(r.journalDir!, "journal.jsonl")).catch(() => undefined))?.mtimeMs ?? 0);
  const anyRunning = j.agents.some((a) => a.state === "running");
  const live = anyRunning && journalAge < 30 * 60_000;

  return {
    runId: r.runId,
    sessionId: r.sessionId,
    project: r.project,
    name,
    status: live ? "running" : "interrupted",
    startTime: j.started,
    phases,
    agents: j.agents,
    agentCount: j.agents.length,
    scriptPath,
    live,
  };
}

export async function listRuns() {
  const runs = await Promise.all((await findRuns()).map((r) => load(r).catch(() => undefined)));
  return runs.filter((r): r is WorkflowRun => !!r).sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
}

export async function getRun(runId: string) {
  const r = (await findRuns()).find((x) => x.runId === runId);
  if (!r) return;
  const run = await load(r);
  const result = r.summaryFile ? JSON.parse(await readFile(r.summaryFile, "utf8")).result : undefined;
  const script = run.scriptPath && existsSync(run.scriptPath) ? await readFile(run.scriptPath, "utf8") : undefined;
  return { ...run, result, script };
}
