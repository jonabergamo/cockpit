import { ClaudeOnly } from "../components/ClaudeOnly";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConfigFile, DoctorIssue } from "@cockpit/shared";
import { Button, Empty, ErrorNote, inputClass, Loading, Markdown, Modal, Tabs, Tag } from "../components/ui";
import { api, qs } from "../lib/api";
import { ago, bytes } from "../lib/format";
import { useEditorFont } from "../lib/fonts";
import { editorTheme } from "../lib/monaco";
import "../lib/monaco";

const groupNames: Record<ConfigFile["group"], string> = {
  global: "Global",
  settings: "Settings",
  skill: "Skills",
  memory: "Memory",
  plan: "Plans",
  workflow: "Workflows",
  project: "Project config",
};

const memDirOf = (path: string) => path.split("/").slice(-3)[0];

export function MemoryPage() {
  const { path } = useSearch({ from: "/memory" });
  const navigate = useNavigate();
  const files = useQuery({ queryKey: ["claude-files"], queryFn: () => api.get<ConfigFile[]>("/claude/files") });
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => api.get<DoctorIssue[]>("/claude/doctor") });
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["plan", "project"]));

  const groups = useMemo(() => {
    const out = new Map<string, ConfigFile[]>();
    for (const f of files.data ?? []) {
      if (filter && !`${f.label} ${f.project ?? ""}`.toLowerCase().includes(filter.toLowerCase())) continue;
      const key = f.group === "memory" ? `memory:${f.project}` : f.group;
      out.set(key, [...(out.get(key) ?? []), f]);
    }
    return out;
  }, [files.data, filter]);

  const select = (p: string) => navigate({ to: "/memory", search: { path: p } });
  const toggle = (k: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div className="h-full flex flex-col">
      <ClaudeOnly what="Memory & skills" className="m-3 mb-0">
        It shows Claude Code's memory, CLAUDE.md, skills and settings. Codex reads AGENTS.md in your repo and its skills in ~/.codex/skills, which you edit there.
      </ClaudeOnly>
      <div className="flex-1 min-h-0 flex">
      <aside className="w-[300px] shrink-0 border-r border-line bg-panel flex flex-col min-h-0 max-md:hidden">
        <div className="p-2 border-b border-line">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter memory, skills, config" className={`${inputClass} w-full h-7 text-[13px]`} />
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {!!doctor.data?.length && (
            <div className="mx-2 mb-2 rounded-md border border-line bg-raised p-2 text-[12px] space-y-1">
              <div className="font-medium text-[13px]">Doctor found {doctor.data.length} things</div>
              {doctor.data.map((d, i) => (
                <div key={i} className={d.level === "error" ? "text-red" : "text-amber"}>
                  <span className="text-muted">{d.where}:</span> {d.message}
                </div>
              ))}
            </div>
          )}
          {files.isLoading && <Loading />}
          {[...groups.entries()].map(([key, list]) => {
            const g = list[0].group;
            const title = g === "memory" ? `Memory · ${list[0].project}` : groupNames[g];
            const isCollapsed = collapsed.has(key) && !filter;
            return (
              <div key={key} className="mb-1">
                <div className="flex items-center px-2 h-7 text-[12px] text-muted">
                  <button onClick={() => toggle(key)} className="flex-1 text-left truncate hover:text-ink">
                    {isCollapsed ? "▸" : "▾"} {title}
                  </button>
                  {g === "memory" && (
                    <button onClick={() => setCreating(memDirOf(list[0].path))} className="text-cobalt hover:underline">
                      new
                    </button>
                  )}
                </div>
                {!isCollapsed &&
                  list.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => select(f.path)}
                      title={f.path}
                      className={`w-full flex items-center gap-2 pl-6 pr-2 h-6 text-left text-[13px] ${path === f.path ? "bg-cobalt-soft text-cobalt" : "hover:bg-ground"}`}
                    >
                      <span className="truncate flex-1">{f.label}</span>
                      {g === "project" && <span className="text-[11px] text-faint truncate max-w-[110px]">{f.project}</span>}
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
      </aside>
      <div className="flex-1 min-w-0">{path ? <FileEditor key={path} path={path} /> : <Empty>Pick a file. Every save keeps a backup you can diff and restore.</Empty>}</div>
      {creating && <NewMemory project={creating} onClose={() => setCreating(undefined)} onCreated={select} />}
    </div>
    </div>
  );
}

function FileEditor({ path }: { path: string }) {
  const editorFont = useEditorFont();
  const qc = useQueryClient();
  const file = useQuery({ queryKey: ["cfg", path], queryFn: () => api.get<{ content: string; mtime: number }>(`/claude/file${qs({ path })}`), staleTime: Infinity });
  const backups = useQuery({ queryKey: ["backups", path], queryFn: () => api.get<{ file: string; at: number }[]>(`/claude/backups${qs({ path })}`) });
  const [content, setContent] = useState<string>();
  const [mtime, setMtime] = useState<number>();
  const [mode, setMode] = useState<"edit" | "preview" | "history">("edit");
  const [backup, setBackup] = useState<string>();
  const isMd = path.endsWith(".md");

  useEffect(() => {
    if (file.data) {
      setContent(file.data.content);
      setMtime(file.data.mtime);
    }
  }, [file.data]);

  const backupText = useQuery({ queryKey: ["backup", backup], queryFn: () => api.get<string>(`/claude/backups/${backup}`), enabled: !!backup });

  const save = useMutation({
    mutationFn: () => api.put<{ mtime: number }>("/claude/file", { path, content, mtime }),
    onSuccess: (r) => {
      setMtime(r.mtime);
      qc.setQueryData(["cfg", path], { content, mtime: r.mtime });
      qc.invalidateQueries({ queryKey: ["backups", path] });
      qc.invalidateQueries({ queryKey: ["doctor"] });
      qc.invalidateQueries({ queryKey: ["claude-files"] });
    },
  });
  const saveRef = useRef(() => save.mutate());
  saveRef.current = () => save.mutate();
  const onMount: OnMount = (editor, monaco) => editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());

  if (file.isLoading || content === undefined) return file.error ? <ErrorNote error={file.error} /> : <Loading />;
  const dirty = content !== file.data?.content;

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 min-h-11 py-1.5 border-b border-line bg-panel">
        <span className="font-mono text-[12px] text-muted truncate flex-1 min-w-[200px]" title={path}>
          {path.replace(/^\/home\/[^/]+/, "~")}
        </span>
        {dirty && <Tag tone="amber">unsaved</Tag>}
        <Tabs
          value={mode}
          onChange={setMode}
          items={[
            { value: "edit", label: "Edit" },
            ...(isMd ? [{ value: "preview" as const, label: "Preview" }] : []),
            { value: "history", label: `Backups${backups.data?.length ? ` ${backups.data.length}` : ""}` },
          ]}
        />
        <Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving" : "Save"}
        </Button>
      </div>
      <ErrorNote error={save.error} />
      <div className="flex-1 min-h-0">
        {mode === "edit" && (
          <Editor
            path={`cfg://${path}`}
            defaultValue={content}
            language={path.endsWith(".json") ? "json" : path.endsWith(".js") ? "javascript" : path.endsWith(".sh") ? "shell" : "markdown"}
            theme={editorTheme()}
            onMount={onMount}
            onChange={(v) => setContent(v ?? "")}
            options={{ ...editorFont, wordWrap: "on", minimap: { enabled: false }, scrollBeyondLastLine: false }}
          />
        )}
        {mode === "preview" && (
          <div className="h-full overflow-y-auto px-8 py-6">
            <Markdown>{content.replace(/^---\n[\s\S]*?\n---\n/, "")}</Markdown>
          </div>
        )}
        {mode === "history" && (
          <div className="h-full flex">
            <ul className="w-[220px] border-r border-line overflow-y-auto">
              {backups.data?.map((b) => (
                <li key={b.file}>
                  <button onClick={() => setBackup(b.file)} className={`w-full text-left px-3 py-1.5 text-[13px] ${backup === b.file ? "bg-cobalt-soft text-cobalt" : "hover:bg-ground"}`}>
                    {new Date(b.at).toLocaleString()}
                    <div className="text-[12px] text-muted">{ago(b.at)}</div>
                  </button>
                </li>
              ))}
              {!backups.data?.length && <li className="px-3 py-3 text-[13px] text-muted">No backups yet. One is made before every save.</li>}
            </ul>
            <div className="flex-1 min-w-0 flex flex-col">
              {backup && backupText.data !== undefined ? (
                <>
                  <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-[13px]">
                    <span className="flex-1 text-muted">Left is the backup, right is the current text ({bytes(backupText.data.length)})</span>
                    <Button size="sm" onClick={() => (setContent(backupText.data!), setMode("edit"))}>
                      Restore into editor
                    </Button>
                  </div>
                  <div className="flex-1">
                    <DiffEditor original={backupText.data} modified={content} language="markdown" theme={editorTheme()} options={{ readOnly: true, fontSize: 13, renderSideBySide: true }} />
                  </div>
                </>
              ) : (
                <Empty>Pick a backup to compare.</Empty>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NewMemory({ project, onClose, onCreated }: { project: string; onClose: () => void; onCreated: (path: string) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", description: "", type: "feedback", body: "" });
  const create = useMutation({
    mutationFn: () => api.post<{ path: string }>("/claude/memories", { project, ...form }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["claude-files"] });
      onClose();
      onCreated(r.path);
    },
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal open onClose={onClose} title="New memory">
      <div className="space-y-2.5">
        <input value={form.name} onChange={set("name")} placeholder="Short name, like conventional commits" className={`${inputClass} w-full`} />
        <input value={form.description} onChange={set("description")} placeholder="One line Claude reads to decide if it's relevant" className={`${inputClass} w-full`} />
        <select value={form.type} onChange={set("type")} className={`${inputClass} w-full`}>
          <option value="user">user: who you are and how you like to work</option>
          <option value="feedback">feedback: a correction or a confirmed approach</option>
          <option value="project">project: ongoing work and constraints</option>
          <option value="reference">reference: a pointer to something external</option>
        </select>
        <textarea value={form.body} onChange={set("body")} rows={6} placeholder="The fact. For feedback and project, add Why and How to apply lines." className={`${inputClass} w-full h-auto py-2`} />
        <ErrorNote error={create.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!form.name || !form.description || !form.body || create.isPending} onClick={() => create.mutate()}>
            Save memory
          </Button>
        </div>
      </div>
    </Modal>
  );
}
