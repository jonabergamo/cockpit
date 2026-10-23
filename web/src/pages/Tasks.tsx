import { DiffEditor } from "@monaco-editor/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import type { Session, Task, TaskStatus } from "@cockpit/shared";
import { ReplyPanel } from "../components/ReplyPanel";
import { Button, Empty, ErrorNote, Loading, Modal, PageHeader, Tag } from "../components/ui";
import { api, qs } from "../lib/api";
import { useCost } from "../lib/cost";
import { useEditorFont } from "../lib/fonts";
import { ago, shortPath } from "../lib/format";
import { useLive } from "../lib/live";
import { editorTheme } from "../lib/monaco";
import { useOpenSession } from "../lib/openSession";

const statusTone: Record<TaskStatus, "plain" | "cobalt" | "green" | "red" | "amber"> = { queued: "plain", starting: "cobalt", running: "cobalt", done: "green", failed: "red", cancelled: "plain" };

const useTasks = () => {
  const qc = useQueryClient();
  useLive((ev) => ev.type === "board" && qc.invalidateQueries({ queryKey: ["tasks"] }), [qc]);
  return useQuery({ queryKey: ["tasks"], queryFn: () => api.get<Task[]>("/tasks"), refetchInterval: 15_000 });
};

// Waves: a group that waits on others goes one column after the latest of them.
export function waves(groups: { group: string; dependsOn: string[] }[]) {
  const level = new Map<string, number>();
  const byId = new Map(groups.map((g) => [g.group, g]));
  const visit = (g: string, seen = new Set<string>()): number => {
    if (level.has(g)) return level.get(g)!;
    if (seen.has(g)) return 0;
    seen.add(g);
    const deps = byId.get(g)?.dependsOn.filter((d) => byId.has(d)) ?? [];
    const l = deps.length ? Math.max(...deps.map((d) => visit(d, seen))) + 1 : 0;
    level.set(g, l);
    return l;
  };
  groups.forEach((g) => visit(g.group));
  return level;
}

// The Work screen's "Queued and attempts" filter: every task by wave, each opening its attempts side by side.
export function TasksList() {
  const q = useTasks();
  const all = q.data ?? [];
  const groups = [...new Map(all.map((t) => [t.group, t])).values()];
  const lvl = waves(groups.map((g) => ({ group: g.group, dependsOn: g.dependsOn })));
  const depth = Math.max(0, ...lvl.values());
  return (
    <div className="space-y-4">
      <ErrorNote error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : !groups.length ? (
        <Empty>No tasks yet. Queue one and cockpit sets up a worktree and starts Claude in it.</Empty>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2 max-md:flex-col">
          {Array.from({ length: depth + 1 }, (_, w) => (
            <section key={w} className="flex-1 min-w-[260px] space-y-2">
              <h2 className="text-[12px] text-faint px-1">{depth ? `Wave ${w + 1}` : "All tasks"}</h2>
              {groups
                .filter((g) => (lvl.get(g.group) ?? 0) === w)
                .map((g) => {
                  const tries = all.filter((t) => t.group === g.group);
                  const waitsOn = g.dependsOn.map((d) => groups.find((x) => x.group === d || x.id === d)?.title).filter(Boolean);
                  return (
                    <Link key={g.group} to="/tasks/$group" params={{ group: g.group }} className="block rounded-md border border-line bg-panel hover:border-faint px-3 py-2 space-y-1.5">
                      <div className="text-[13px] font-medium line-clamp-2">{g.title}</div>
                      <div className="flex flex-wrap gap-1">
                        {tries.map((t) => (
                          <Tag key={t.id} tone={statusTone[t.status]}>
                            {tries.length > 1 ? `#${t.attempt} ` : ""}
                            {t.status}
                          </Tag>
                        ))}
                        {g.ticket && <Tag>{g.ticket}</Tag>}
                      </div>
                      {waitsOn.length > 0 && <div className="text-[12px] text-muted truncate">After {waitsOn.join(", ")}</div>}
                      <div className="text-[11px] text-faint">{ago(g.createdAt)}</div>
                    </Link>
                  );
                })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

interface Attempt {
  task: Task;
  files: { path: string; added: number; removed: number; status: string }[];
  session?: Pick<Session, "id" | "status" | "costUSD" | "linesAdded" | "linesRemoved" | "updatedAt">;
}
interface Group {
  title: string;
  prompt: string;
  ticket?: string;
  dependsOn: string[];
  attempts: Attempt[];
}

function FileDiff({ task, path, onClose }: { task: Task; path: string; onClose: () => void }) {
  const font = useEditorFont();
  const q = useQuery({ queryKey: ["task-file", task.id, path], queryFn: () => api.get<{ before: string; after: string }>(`/tasks/${task.id}/file${qs({ path })}`) });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-[1400px] h-full bg-panel border border-line rounded-lg shadow-xl flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-4 h-11 border-b border-line shrink-0">
          <div className="text-[13px] font-medium truncate flex-1">
            {path} <span className="text-faint font-normal">· attempt {task.attempt}</span>
          </div>
          <button onClick={onClose} className="size-7 rounded text-faint hover:text-ink hover:bg-ground" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0">
          {q.data ? (
            <DiffEditor original={q.data.before} modified={q.data.after} originalModelPath={`task://${task.id}/base/${path}`} modifiedModelPath={`task://${task.id}/now/${path}`} theme={editorTheme()} options={{ readOnly: true, renderSideBySide: window.innerWidth > 1100, hideUnchangedRegions: { enabled: true }, minimap: { enabled: false }, ...font }} />
          ) : (
            <div className="p-4 text-[13px] text-muted">{q.error ? String((q.error as Error).message) : "Reading the file"}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function TaskGroupPage() {
  const { group } = useParams({ from: "/tasks/$group" });
  const qc = useQueryClient();
  const openSession = useOpenSession();
  const cost = useCost();
  const [file, setFile] = useState<{ task: Task; path: string }>();
  const [confirm, setConfirm] = useState<Task>();
  const [err, setErr] = useState<unknown>();
  useLive((ev) => ev.type === "board" && qc.invalidateQueries({ queryKey: ["task-group", group] }), [qc, group]);
  const q = useQuery({ queryKey: ["task-group", group], queryFn: () => api.get<Group>(`/tasks/group/${group}`), refetchInterval: 10_000 });
  const act = async (path: string) => {
    setErr(undefined);
    try {
      await api.post(path);
      await Promise.all([qc.invalidateQueries({ queryKey: ["task-group", group] }), qc.invalidateQueries({ queryKey: ["board"] })]);
    } catch (e) {
      setErr(e);
    }
  };
  const g = q.data;
  const many = (g?.attempts.length ?? 0) > 1;

  return (
    <div className="space-y-4">
      <PageHeader title={g?.title ?? "Task"} sub={g ? `${g.ticket ? `${g.ticket} · ` : ""}${many ? `${g.attempts.length} attempts side by side` : "One attempt"}` : undefined}>
        <Link to="/board" search={{ filter: "tasks" }}>
          <Button variant="ghost">All tasks</Button>
        </Link>
      </PageHeader>
      <ErrorNote error={q.error ?? err} />
      {!g ? (
        <Loading />
      ) : (
        <>
          <details className="bg-panel border border-line rounded-lg px-4 py-2.5 text-[13px]">
            <summary className="cursor-pointer text-muted">What Claude was asked</summary>
            <pre className="mt-2 whitespace-pre-wrap font-sans">{g.prompt}</pre>
          </details>
          <div className={`grid gap-3 ${many ? "md:grid-cols-2 xl:grid-cols-3" : ""}`}>
            {g.attempts.map(({ task: t, files, session }) => {
              const added = files.reduce((n, f) => n + f.added, 0);
              const removed = files.reduce((n, f) => n + f.removed, 0);
              return (
                <section key={t.id} className="bg-panel border border-line rounded-lg p-4 space-y-3 min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold flex-1">{many ? `Attempt ${t.attempt}` : "Progress"}</h2>
                    <Tag tone={statusTone[t.status]}>{t.status}</Tag>
                  </div>
                  <div className="text-[12px] text-muted space-y-0.5">
                    {t.worktree && <div className="truncate">{shortPath(t.worktree)}</div>}
                    {t.branch && <div className="font-mono truncate">{t.branch}</div>}
                    {t.error && <div className="text-red">{t.error}</div>}
                    {session && (
                      <div>
                        {session.costUSD && !cost.hidden ? `${cost.fmt(session.costUSD)} · ` : ""}
                        {files.length} files, <span className="text-green">+{added}</span> <span className="text-red">−{removed}</span> · {ago(session.updatedAt)}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {session && (
                      <Link to="/sessions/$id" params={{ id: session.id }}>
                        <Button size="sm">Transcript</Button>
                      </Link>
                    )}
                    {session && (
                      <Button size="sm" onClick={() => openSession({ id: session.id })}>
                        Terminal
                      </Button>
                    )}
                    {t.worktree && (
                      <Link to="/code" search={{ root: t.worktree }}>
                        <Button size="sm">Code</Button>
                      </Link>
                    )}
                    {(t.status === "running" || t.status === "starting" || t.status === "queued") && (
                      <>
                        {t.status === "running" && (
                          <Button size="sm" onClick={() => act(`/tasks/${t.id}/done`)}>
                            Mark done
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => act(`/tasks/${t.id}/cancel`)}>
                          Cancel
                        </Button>
                      </>
                    )}
                    {many && t.status !== "cancelled" && (
                      <Button size="sm" variant="primary" onClick={() => setConfirm(t)}>
                        Keep this one
                      </Button>
                    )}
                  </div>
                  {session && session.status !== "ended" && <ReplyPanel session={{ id: session.id, status: session.status }} compact />}
                  {files.length > 0 && (
                    <div className="rounded-md border border-line divide-y divide-line max-h-80 overflow-y-auto">
                      {files.map((f) => (
                        <button key={f.path} onClick={() => setFile({ task: t, path: f.path })} className="w-full flex items-center gap-2 px-2.5 h-7 text-[12.5px] hover:bg-ground text-left">
                          <span className="font-mono text-[11px] w-3 text-amber">{f.status}</span>
                          <span className="truncate flex-1">{f.path}</span>
                          <span className="text-[11px] text-green">+{f.added}</span>
                          <span className="text-[11px] text-red">−{f.removed}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
      {file && <FileDiff task={file.task} path={file.path} onClose={() => setFile(undefined)} />}
      <Modal open={!!confirm} onClose={() => setConfirm(undefined)} title={`Keep attempt ${confirm?.attempt}?`}>
        <p className="text-[13px] text-muted">The other attempts stop and their worktrees are removed. Their sessions stay in Sessions.</p>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setConfirm(undefined)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (confirm) act(`/tasks/${confirm.id}/keep`);
              setConfirm(undefined);
            }}
          >
            Keep it, remove the rest
          </Button>
        </div>
      </Modal>
    </div>
  );
}
