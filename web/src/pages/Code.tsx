import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { FileTree } from "../components/FileTree";
import { RootPicker } from "../components/RootPicker";
import { Terminal } from "../components/Terminal";
import { Button, Empty, ErrorNote, inputClass, Loading, Tabs } from "../components/ui";
import { useAgentName } from "../lib/agent";
import { api, qs } from "../lib/api";
import { ago } from "../lib/format";
import { useEditorFont } from "../lib/fonts";
import { editorTheme } from "../lib/monaco";
import "../lib/monaco";

interface Tab {
  path: string;
  content: string;
  original: string;
  mtime: number;
  binary?: boolean;
  tooLarge?: boolean;
}

interface Change {
  path: string;
  index: string;
  work: string;
}

export function CodePage() {
  const { root, file, diff } = useSearch({ from: "/code" });
  const navigate = useNavigate();

  if (!root) {
    return (
      <div className="max-w-lg mx-auto mt-16 px-4">
        <h1 className="text-[22px] font-semibold mb-1">Code</h1>
        <p className="text-muted mb-4">Pick a worktree or project to browse, edit and run things in.</p>
        <RootPicker value="" onChange={(v) => v && navigate({ to: "/code", search: { root: v } })} />
      </div>
    );
  }
  return <Workspace key={root} root={root} initialFile={file} initialDiff={diff} />;
}

function Workspace({ root, initialFile, initialDiff }: { root: string; initialFile?: string; initialDiff?: boolean }) {
  const agent = useAgentName();
  const editorFont = useEditorFont();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const r = qs({ root });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>();
  const [side, setSide] = useState<"files" | "changes" | "search">(initialDiff ? "changes" : "files");
  const [diff, setDiff] = useState(!!initialDiff);
  const [filter, setFilter] = useState("");
  const [term, setTerm] = useState<string>();
  const [termOpen, setTermOpen] = useState(false);
  const [err, setErr] = useState<unknown>();
  const fq = useDeferredValue(filter);

  const tree = useQuery({ queryKey: ["tree", root], queryFn: () => api.get<string[]>(`/code/fs/tree${r}`), staleTime: 60_000 });
  const changes = useQuery({ queryKey: ["changes", root], queryFn: () => api.get<Change[]>(`/code/fs/changes${r}`), refetchInterval: 10_000 });
  const info = useQuery({ queryKey: ["info", root], queryFn: () => api.get<{ branch: string; log: { sha: string; at: number; subject: string }[] }>(`/code/fs/info${r}`) });
  const changed = new Map((changes.data ?? []).map((c) => [c.path, (c.index + c.work).trim()]));

  const tab = tabs.find((t) => t.path === active);

  const open = useCallback(
    async (path: string) => {
      setActive(path);
      navigate({ to: "/code", search: { root, file: path }, replace: true });
      if (tabs.some((t) => t.path === path)) return;
      try {
        const f = await api.get<{ content: string; mtime: number; binary: boolean; tooLarge: boolean }>(`/code/fs/file${qs({ root, path })}`);
        setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, { path, content: f.content, original: f.content, mtime: f.mtime, binary: f.binary, tooLarge: f.tooLarge }]));
      } catch (e) {
        setErr(e);
      }
    },
    [root, tabs, navigate],
  );

  useEffect(() => {
    if (initialFile) open(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(async () => {
    const t = tabs.find((x) => x.path === active);
    if (!t || t.content === t.original) return;
    try {
      const res = await api.put<{ mtime: number }>(`/code/fs/file${r}`, { path: t.path, content: t.content, mtime: t.mtime });
      setTabs((ts) => ts.map((x) => (x.path === t.path ? { ...x, original: t.content, mtime: res.mtime } : x)));
      setErr(undefined);
      qc.invalidateQueries({ queryKey: ["changes", root] });
    } catch (e) {
      setErr(e);
    }
  }, [tabs, active, r, root, qc]);

  const saveRef = useRef(save);
  saveRef.current = save;
  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
  };

  const close = (path: string) => {
    const t = tabs.find((x) => x.path === path);
    if (t && t.content !== t.original && !confirm(`Discard unsaved changes to ${path}?`)) return;
    const rest = tabs.filter((x) => x.path !== path);
    setTabs(rest);
    if (active === path) setActive(rest.at(-1)?.path);
  };

  const head = useQuery({
    queryKey: ["head", root, active],
    queryFn: () => api.get<{ content: string }>(`/code/fs/head${qs({ root, path: active })}`),
    enabled: diff && !!active,
  });

  const openTerminal = async (claude = false) => {
    const t = claude ? await api.post<{ id: string }>("/claude/launch", { cwd: root }) : await api.post<{ id: string }>("/code/terms", { cwd: root, title: root.split("/").slice(-2).join("/") });
    setTerm(t.id);
    setTermOpen(true);
  };

  const names = fq ? (tree.data ?? []).filter((p) => p.toLowerCase().includes(fq.toLowerCase())).slice(0, 300) : [];

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 h-11 border-b border-line bg-panel shrink-0">
        <div className="w-[300px] max-w-[45vw]">
          <RootPicker value={root} onChange={(v) => v && navigate({ to: "/code", search: { root: v } })} className="h-7 text-[13px]" />
        </div>
        <span className="text-[13px] text-muted font-mono truncate">{info.data?.branch}</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setDiff((d) => !d)} disabled={!tab}>
            {diff ? "Edit" : "Diff vs HEAD"}
          </Button>
          <Button size="sm" onClick={() => (term ? setTermOpen((o) => !o) : openTerminal())}>
            Terminal
          </Button>
          <Button size="sm" onClick={() => openTerminal(true)}>
            {agent} here
          </Button>
          <Button size="sm" variant="primary" onClick={() => api.post("/worktrees/open", { path: root }).catch(setErr)}>
            VS Code
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <aside className="w-[280px] shrink-0 border-r border-line bg-panel flex flex-col min-h-0 max-md:hidden">
          <div className="p-2 space-y-2 border-b border-line">
            <Tabs
              value={side}
              onChange={setSide}
              items={[
                { value: "files", label: "Files" },
                { value: "changes", label: `Changes${changes.data?.length ? ` ${changes.data.length}` : ""}` },
                { value: "search", label: "Search" },
              ]}
            />
            {side === "files" && <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a file" className={`${inputClass} w-full h-7 text-[13px]`} />}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {side === "files" &&
              (tree.isLoading ? (
                <Loading shape="lines" rows={8} />
              ) : fq ? (
                names.map((p) => (
                  <button key={p} onClick={() => open(p)} className="w-full text-left px-3 h-6 text-[13px] truncate hover:bg-ground" title={p}>
                    {p}
                  </button>
                ))
              ) : (
                <FileTree paths={tree.data ?? []} active={active} changed={changed} onOpen={open} />
              ))}
            {side === "changes" && <ChangesPanel root={root} changes={changes.data ?? []} onOpen={(p) => (setDiff(true), open(p))} log={info.data?.log ?? []} />}
            {side === "search" && <SearchPanel root={root} onOpen={open} />}
          </div>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center h-9 border-b border-line bg-panel overflow-x-auto shrink-0">
            {tabs.map((t) => (
              <div
                key={t.path}
                onClick={() => setActive(t.path)}
                title={t.path}
                className={`group flex items-center gap-1.5 h-full pl-3 pr-1 border-r border-line cursor-pointer shrink-0 text-[13px] ${t.path === active ? "bg-raised" : "text-muted hover:text-ink"}`}
              >
                <span>{t.path.split("/").pop()}</span>
                {t.content !== t.original && <span className="size-1.5 rounded-full bg-amber" />}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t.path);
                  }}
                  className="size-5 rounded text-faint hover:text-ink hover:bg-ground"
                  aria-label={`Close ${t.path}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <ErrorNote error={err} />
          <div className="flex-1 min-h-0">
            {!tab ? (
              <Empty>Open a file from the tree. ⌘S saves.</Empty>
            ) : tab.binary || tab.tooLarge ? (
              <Empty>{tab.binary ? "Binary file, not shown." : "File is too large to open here."}</Empty>
            ) : diff ? (
              <DiffEditor
                key={`diff:${tab.path}`}
                original={head.data?.content ?? ""}
                modified={tab.content}
                originalModelPath={`head://${tab.path}`}
                modifiedModelPath={`diff://${tab.path}`}
                theme={editorTheme()}
                options={{ readOnly: true, renderSideBySide: window.innerWidth > 1100, ...editorFont }}
              />
            ) : (
              <Editor
                path={tab.path}
                defaultValue={tab.content}
                theme={editorTheme()}
                onMount={onMount}
                onChange={(v) => setTabs((ts) => ts.map((x) => (x.path === tab.path ? { ...x, content: v ?? "" } : x)))}
                options={{ ...editorFont, minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 2 }}
              />
            )}
          </div>
          {term && termOpen && (
            <div className="h-[38%] min-h-[160px] border-t border-line flex flex-col">
              <div className="flex items-center h-7 px-2 bg-panel text-[12px] text-muted gap-2">
                <span className="flex-1">Terminal</span>
                <button onClick={() => navigate({ to: "/terminals", search: { id: term } })} className="hover:text-ink">
                  Pop out
                </button>
                <button onClick={() => setTermOpen(false)} className="hover:text-ink">
                  Hide
                </button>
              </div>
              <div className="flex-1 min-h-0">
                <Terminal id={term} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChangesPanel({ root, changes, onOpen, log }: { root: string; changes: Change[]; onOpen: (p: string) => void; log: { sha: string; at: number; subject: string }[] }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState("");
  const r = qs({ root });
  const refresh = () => Promise.all(["changes", "info"].map((k) => qc.invalidateQueries({ queryKey: [k, root] })));

  const stage = useMutation({ mutationFn: (b: { paths: string[]; on: boolean }) => api.post(`/code/fs/stage${r}`, b), onSuccess: refresh });
  const commit = useMutation({
    mutationFn: () => api.post(`/code/fs/commit${r}`, { message: msg }),
    onSuccess: () => {
      setMsg("");
      refresh();
    },
  });
  const push = useMutation({ mutationFn: () => api.post<{ out: string }>(`/code/fs/push${r}`), onSuccess: refresh });

  const staged = changes.filter((c) => c.index !== " " && c.index !== "?");
  const unstaged = changes.filter((c) => c.work !== " " || c.index === "?");

  const row = (c: Change, on: boolean) => (
    <div key={`${on}:${c.path}`} className="group flex items-center gap-1 px-2 h-6 text-[13px] hover:bg-ground">
      <button onClick={() => onOpen(c.path)} className="flex-1 text-left truncate" title={c.path}>
        {c.path.split("/").pop()} <span className="text-faint text-[11px]">{c.path.split("/").slice(0, -1).join("/")}</span>
      </button>
      <span className="text-[11px] text-amber w-4 text-center">{on ? (c.work === " " ? c.index : c.work) : c.index}</span>
      <button onClick={() => stage.mutate({ paths: [c.path], on })} className="text-[12px] text-cobalt opacity-0 group-hover:opacity-100 w-10">
        {on ? "stage" : "unstage"}
      </button>
    </div>
  );

  return (
    <div className="py-2 space-y-3">
      <div className="px-2 space-y-1.5">
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={2} placeholder="Commit message" className={`${inputClass} h-auto w-full py-1.5 text-[13px]`} />
        <div className="flex gap-1.5">
          <Button size="sm" variant="primary" disabled={!msg.trim() || !staged.length || commit.isPending} onClick={() => commit.mutate()} className="flex-1">
            Commit {staged.length || ""}
          </Button>
          <Button size="sm" disabled={push.isPending} onClick={() => push.mutate()}>
            {push.isPending ? "Pushing" : "Push"}
          </Button>
        </div>
        <ErrorNote error={commit.error ?? push.error ?? stage.error} />
      </div>
      {staged.length > 0 && (
        <div>
          <div className="px-2 text-[12px] text-muted mb-0.5">Staged</div>
          {staged.map((c) => row(c, false))}
        </div>
      )}
      <div>
        <div className="px-2 text-[12px] text-muted mb-0.5 flex">
          <span className="flex-1">Changes</span>
          {unstaged.length > 0 && (
            <button className="text-cobalt" onClick={() => stage.mutate({ paths: unstaged.map((c) => c.path), on: true })}>
              stage all
            </button>
          )}
        </div>
        {unstaged.map((c) => row(c, true))}
        {!changes.length && <div className="px-2 text-[13px] text-muted">Working tree is clean.</div>}
      </div>
      {log.length > 0 && (
        <div>
          <div className="px-2 text-[12px] text-muted mb-0.5">Recent commits</div>
          {log.map((l) => (
            <div key={l.sha} className="px-2 py-0.5 text-[12px]" title={l.subject}>
              <div className="truncate">{l.subject}</div>
              <div className="text-faint">
                {l.sha} · {ago(l.at)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SearchPanel({ root, onOpen }: { root: string; onOpen: (p: string) => void }) {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const res = useQuery({
    queryKey: ["search", root, submitted],
    queryFn: () => api.get<{ path: string; line: number; text: string }[]>(`/code/fs/search${qs({ root, q: submitted })}`),
    enabled: !!submitted,
  });
  return (
    <div className="p-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search in files, Enter to run" className={`${inputClass} w-full h-7 text-[13px]`} />
      </form>
      {res.isFetching && <Loading what="Searching" />}
      <ErrorNote error={res.error} />
      <div className="mt-2 space-y-0.5">
        {res.data?.map((h, i) => (
          <button key={i} onClick={() => onOpen(h.path)} className="w-full text-left px-1 py-0.5 rounded hover:bg-ground">
            <div className="text-[12px] text-muted truncate">
              {h.path}:{h.line}
            </div>
            <div className="font-mono text-[12px] truncate">{h.text.trim()}</div>
          </button>
        ))}
        {res.data?.length === 0 && <div className="text-[13px] text-muted">No matches.</div>}
      </div>
    </div>
  );
}
