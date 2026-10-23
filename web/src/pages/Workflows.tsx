import Editor from "@monaco-editor/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import type { Session, WorkflowAgent, WorkflowRun } from "@cockpit/shared";
import { Button, Empty, ErrorNote, inputClass, Loading, Modal, PageHeader, Tabs, Tag } from "../components/ui";
import { api } from "../lib/api";
import { ago, duration, shortPath } from "../lib/format";
import { useEditorFont } from "../lib/fonts";
import { editorTheme } from "../lib/monaco";
import "../lib/monaco";

const stateTone = (s: string) => (/run|start/.test(s) ? "cobalt" : /done|complete|success/.test(s) ? "green" : /fail|error|kill|interrupt/.test(s) ? "red" : "faint");
const k = (n?: number) => (n ? `${Math.round(n / 1000)}k` : "");

export function WorkflowsPage() {
  const runs = useQuery({ queryKey: ["workflows"], queryFn: () => api.get<WorkflowRun[]>("/claude/workflows"), refetchInterval: (q) => (q.state.data?.some((r) => r.live) ? 3000 : 15_000) });

  return (
    <div className="max-w-[1100px]">
      <PageHeader title="Workflows" sub="Multi-agent runs started from your Claude sessions." />
      {runs.isLoading && <Loading />}
      <ErrorNote error={runs.error} />
      {runs.data?.length === 0 && <Empty>No workflow runs yet.</Empty>}
      <div className="bg-panel border border-line rounded-lg divide-y divide-line">
        {runs.data?.map((r) => (
          <Link key={r.runId} to="/workflows/$id" params={{ id: r.runId }} className={`flex items-center gap-3 px-3 py-2.5 hover:bg-ground ${r.live ? "relative overflow-hidden sweep" : ""}`}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{r.name}</span>
                <Tag tone={stateTone(r.status)}>{r.status}</Tag>
              </div>
              <div className="text-[12px] text-muted truncate">{r.summary ?? r.phases.map((p) => p.title).join(", ")}</div>
            </div>
            <span className="text-[13px] text-muted w-20 text-right">{r.agentCount ?? r.agents.length} agents</span>
            <span className="text-[13px] text-muted w-16 text-right">{k(r.totalTokens)}</span>
            <span className="text-[13px] text-muted w-16 text-right">{duration(r.durationMs)}</span>
            <span className="text-[12px] text-muted w-24 text-right hidden sm:block">{ago(r.startTime)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

type RunDetail = WorkflowRun & { result?: unknown; script?: string };

function AgentCard({ a, sessionId }: { a: WorkflowAgent; sessionId: string }) {
  const body = (
    <div className={`relative overflow-hidden rounded-md border bg-raised px-2.5 py-2 ${/run/.test(a.state) ? "border-cobalt/50 sweep" : "border-line"}`}>
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-[13px] truncate flex-1">{a.label}</span>
        <Tag tone={stateTone(a.state)}>{a.state}</Tag>
      </div>
      {a.lastToolName && (
        <div className="text-[12px] text-muted truncate mt-0.5">
          {a.lastToolName} {a.lastToolSummary}
        </div>
      )}
      <div className="text-[12px] text-faint mt-0.5 flex gap-2">
        {a.model && <span>{a.model.replace("claude-", "")}</span>}
        {a.tokens ? <span>{k(a.tokens)} tokens</span> : null}
        {a.toolCalls ? <span>{a.toolCalls} tools</span> : null}
        {a.durationMs ? <span>{duration(a.durationMs)}</span> : null}
      </div>
      {a.resultPreview && <div className="text-[12px] mt-1.5 line-clamp-3 text-muted">{a.resultPreview}</div>}
    </div>
  );
  return a.agentId ? (
    <Link to="/sessions/$id" params={{ id: sessionId }} search={{ agent: a.agentId }} className="block hover:brightness-[1.03]">
      {body}
    </Link>
  ) : (
    body
  );
}

export function WorkflowPage() {
  const editorFont = useEditorFont();
  const { id } = useParams({ from: "/workflows/$id" });
  const navigate = useNavigate();
  const run = useQuery({ queryKey: ["workflow", id], queryFn: () => api.get<RunDetail>(`/claude/workflows/${id}`), refetchInterval: (q) => (q.state.data?.live ? 2500 : false) });
  const session = useQuery({ queryKey: ["session", run.data?.sessionId], queryFn: () => api.get<Session>(`/sessions/${run.data!.sessionId}`), enabled: !!run.data });
  const [tab, setTab] = useState<"agents" | "script" | "result">("agents");
  const [script, setScript] = useState<string>();
  const [naming, setNaming] = useState<string>();

  const saveAs = useMutation({
    mutationFn: async (name: string) => {
      const home = run.data!.scriptPath!.split("/.claude/")[0];
      await api.put("/claude/file", { path: `${home}/.claude/workflows/${name}.js`, content: script ?? run.data!.script });
      return name;
    },
    onSuccess: () => setNaming(undefined),
  });
  const again = useMutation({
    mutationFn: async () => {
      const path = run.data!.scriptPath;
      const t = await api.post<{ id: string }>("/claude/launch", {
        cwd: session.data!.cwd,
        prompt: `Run the workflow script at ${path} again with the Workflow tool (pass it as scriptPath).`,
      });
      navigate({ to: "/terminals", search: { id: t.id } });
    },
  });

  if (run.isLoading) return <Loading />;
  const r = run.data;
  if (!r) return <ErrorNote error={run.error} />;

  const phases = r.phases.length ? r.phases.map((p) => p.title) : [...new Set(r.agents.map((a) => a.phase ?? "Agents"))];
  const unphased = r.agents.filter((a) => !a.phase || !phases.includes(a.phase));

  return (
    <div className="max-w-[1400px]">
      <div className="text-[13px] text-muted mb-1">
        <Link to="/sessions" search={{ tab: "workflows" }} className="hover:text-ink">
          Workflows
        </Link>
      </div>
      <PageHeader
        title={r.name}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Tag tone={stateTone(r.status)}>{r.status}</Tag>
            {r.summary && <span>{r.summary}</span>}
            {session.data && (
              <Link to="/sessions/$id" params={{ id: r.sessionId }} className="text-cobalt hover:underline">
                from {session.data.title ?? shortPath(session.data.cwd)}
              </Link>
            )}
          </span>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "agents", label: "Agents" },
            { value: "script", label: "Script" },
            ...(r.result ? [{ value: "result" as const, label: "Result" }] : []),
          ]}
        />
      </PageHeader>

      {tab === "agents" && (
        <div className="flex gap-4 overflow-x-auto pb-3">
          {phases.map((p, i) => (
            <div key={p} className="w-[300px] shrink-0">
              <div className="mb-2 px-1">
                <div className="font-semibold">
                  {i + 1}. {p}
                </div>
                {r.phases[i]?.detail && <div className="text-[12px] text-muted">{r.phases[i].detail}</div>}
              </div>
              <div className="space-y-2">
                {r.agents
                  .filter((a) => a.phase === p)
                  .map((a, j) => (
                    <AgentCard key={a.agentId ?? j} a={a} sessionId={r.sessionId} />
                  ))}
              </div>
            </div>
          ))}
          {unphased.length > 0 && (
            <div className="w-[300px] shrink-0 space-y-2">
              <div className="font-semibold mb-2 px-1">Other agents</div>
              {unphased.map((a, j) => (
                <AgentCard key={a.agentId ?? j} a={a} sessionId={r.sessionId} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "script" && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button onClick={() => (saveAs.reset(), setNaming(r.name))} disabled={!r.scriptPath}>
              Save as named workflow
            </Button>
            <Button variant="primary" onClick={() => again.mutate()} disabled={!session.data || !r.scriptPath}>
              Run again in a new session
            </Button>
            {saveAs.data && <span className="text-[13px] text-green self-center">Saved as {saveAs.data}</span>}
          </div>
          <ErrorNote error={again.error} />
          <div className="h-[70vh] border border-line rounded-lg overflow-hidden">
            <Editor
              path={`wf://${r.runId}.js`}
              defaultValue={r.script ?? "// script not found"}
              language="javascript"
              theme={editorTheme()}
              onChange={(v) => setScript(v)}
              options={{ ...editorFont, minimap: { enabled: false } }}
            />
          </div>
        </div>
      )}

      <Modal open={naming !== undefined} onClose={() => setNaming(undefined)} title="Save as named workflow">
        <form
          className="space-y-3"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (naming?.trim()) saveAs.mutate(naming.trim());
          }}
        >
          <input autoFocus value={naming ?? ""} onChange={(ev) => setNaming(ev.target.value)} placeholder="Workflow name" className={`${inputClass} w-full`} />
          <p className="text-[13px] text-muted">Saved to ~/.claude/workflows/{naming?.trim() || "name"}.js, so any session can run it by name.</p>
          <ErrorNote error={saveAs.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setNaming(undefined)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!naming?.trim() || saveAs.isPending}>
              {saveAs.isPending ? "Saving" : "Save"}
            </Button>
          </div>
        </form>
      </Modal>

      {tab === "result" && <pre className="font-mono text-[12px] whitespace-pre-wrap bg-panel border border-line rounded-lg p-4 overflow-auto">{JSON.stringify(r.result, null, 2)}</pre>}
    </div>
  );
}
