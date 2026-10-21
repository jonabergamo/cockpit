import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, qs } from "../lib/api";
import { useEditorFont } from "../lib/fonts";
import { editorTheme } from "../lib/monaco";
import "../lib/monaco";
import { useOpenSession } from "../lib/openSession";
import { Button, ErrorNote, inputClass } from "./ui";

interface Change {
  path: string;
  index: string;
  work: string;
}
interface Note {
  path: string;
  line: number;
  code: string;
  text: string;
}

// Review what a worker changed before there's a PR: click a line number to leave a note, then send all of
// them to its session as one message.
export function DiffReview({ root, sessionId, onClose }: { root: string; sessionId?: string; onClose: () => void }) {
  const font = useEditorFont();
  const openSession = useOpenSession();
  const changes = useQuery({ queryKey: ["changes", root], queryFn: () => api.get<Change[]>(`/code/fs/changes${qs({ root })}`) });
  const files = changes.data ?? [];
  const [active, setActive] = useState<string>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState<{ line: number; code: string; text: string }>();
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [sent, setSent] = useState(false);
  const path = active ?? files[0]?.path;
  const head = useQuery({ queryKey: ["head", root, path], queryFn: () => api.get<{ content: string }>(`/code/fs/head${qs({ root, path })}`), enabled: !!path });
  const file = useQuery({ queryKey: ["file", root, path], queryFn: () => api.get<{ content: string; binary: boolean }>(`/code/fs/file${qs({ root, path })}`).catch(() => ({ content: "", binary: false })), enabled: !!path });
  const editor = useRef<Parameters<DiffOnMount>[0] | undefined>(undefined);
  const decorations = useRef<{ clear(): void } | undefined>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !draft && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose, draft]);

  // a mark in the margin on every line with a note
  useEffect(() => {
    const ed = editor.current?.getModifiedEditor();
    if (!ed) return;
    decorations.current?.clear();
    decorations.current = ed.createDecorationsCollection(
      notes.filter((n) => n.path === path).map((n) => ({ range: { startLineNumber: n.line, startColumn: 1, endLineNumber: n.line, endColumn: 1 }, options: { isWholeLine: true, className: "review-note-line", glyphMarginClassName: "review-note-glyph" } })),
    );
  }, [notes, path, file.data]);

  const onMount: DiffOnMount = (ed, monaco) => {
    editor.current = ed;
    const mod = ed.getModifiedEditor();
    mod.updateOptions({ glyphMargin: true });
    mod.onMouseDown((e) => {
      const t = e.target.type;
      if (t !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && t !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      if (!line) return;
      setDraft({ line, code: mod.getModel()?.getLineContent(line) ?? "", text: "" });
    });
  };

  const send = async () => {
    setSending(true);
    setErr(undefined);
    const msg = [
      "Some notes on your changes so far. Address each one, then tell me what you changed:",
      ...notes.map((n) => `\n${n.path}:${n.line}\n> ${n.code.trim().slice(0, 200)}\n${n.text}`),
    ].join("\n");
    try {
      if (sessionId) {
        const { sent } = await api.post<{ sent: boolean }>(`/sessions/${sessionId}/send`, { text: msg });
        if (!sent) await openSession({ id: sessionId }, msg);
      } else await api.post("/claude/launch", { cwd: root, prompt: msg, title: "review notes" });
      setNotes([]);
      setSent(true);
    } catch (e) {
      setErr(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-[1600px] h-full bg-panel border border-line rounded-lg shadow-xl flex overflow-hidden">
        <aside className="w-[260px] shrink-0 border-r border-line flex flex-col min-h-0 max-md:hidden">
          <div className="px-3 h-11 flex items-center border-b border-line text-[13px] font-medium">Changed files {files.length ? <span className="text-faint font-normal ml-1">{files.length}</span> : null}</div>
          <div className="flex-1 min-h-0 overflow-y-auto py-1">
            {files.map((f) => {
              const count = notes.filter((n) => n.path === f.path).length;
              return (
                <button key={f.path} onClick={() => setActive(f.path)} className={`w-full flex items-center gap-2 px-3 h-7 text-[12.5px] text-left hover:bg-ground ${f.path === path ? "bg-ground text-cobalt" : ""}`} title={f.path}>
                  <span className="truncate flex-1">{f.path}</span>
                  {count > 0 && <span className="text-[11px] text-amber">{count}</span>}
                  <span className="font-mono text-[11px] text-faint">{(f.index + f.work).trim().replace("??", "U")}</span>
                </button>
              );
            })}
            {!files.length && <div className="px-3 py-2 text-[13px] text-muted">{changes.isLoading ? "Reading git" : "Nothing uncommitted to review."}</div>}
          </div>
        </aside>
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center gap-3 px-4 h-11 border-b border-line shrink-0">
            <div className="text-[13px] truncate flex-1">
              <span className="font-medium">{path ?? "Review"}</span>
              <span className="text-faint"> · click a line number to leave a note</span>
            </div>
            {sent && !notes.length && <span className="text-[12px] text-green">Sent to Claude</span>}
            <Button size="sm" variant="primary" disabled={!notes.length || sending} onClick={send}>
              {sending ? "Sending" : notes.length ? `Send ${notes.length} note${notes.length > 1 ? "s" : ""} to Claude` : "Send to Claude"}
            </Button>
            <button onClick={onClose} className="size-7 rounded text-faint hover:text-ink hover:bg-ground" aria-label="Close">
              ✕
            </button>
          </div>
          <div className="flex-1 min-h-0 flex">
            <div className="flex-1 min-w-0">
              {path && head.data && file.data ? (
                <DiffEditor
                  key={path}
                  original={head.data.content}
                  modified={file.data.content}
                  originalModelPath={`review-head://${root}/${path}`}
                  modifiedModelPath={`review-now://${root}/${path}`}
                  theme={editorTheme()}
                  onMount={onMount}
                  options={{ readOnly: true, renderSideBySide: window.innerWidth > 1300, minimap: { enabled: false }, scrollBeyondLastLine: false, ...font }}
                />
              ) : (
                <div className="p-4 text-[13px] text-muted">{path ? "Reading the file" : ""}</div>
              )}
            </div>
            <div className="w-[300px] shrink-0 border-l border-line flex flex-col min-h-0 max-lg:hidden">
              <div className="px-3 h-9 flex items-center text-[12px] text-muted border-b border-line">Notes</div>
              <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
                {draft && (
                  <form
                    className="rounded-md border border-cobalt/60 bg-raised p-2 space-y-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!draft.text.trim() || !path) return;
                      setNotes((n) => [...n, { path, line: draft.line, code: draft.code, text: draft.text.trim() }]);
                      setDraft(undefined);
                    }}
                  >
                    <div className="text-[11.5px] text-muted font-mono truncate">
                      {path}:{draft.line} {draft.code.trim().slice(0, 60)}
                    </div>
                    <textarea
                      autoFocus
                      value={draft.text}
                      onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
                        if (e.key === "Escape") setDraft(undefined);
                      }}
                      rows={3}
                      placeholder="What should change here?"
                      className={`${inputClass} w-full h-auto py-1.5 text-[13px]`}
                    />
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" type="button" variant="ghost" onClick={() => setDraft(undefined)}>
                        Cancel
                      </Button>
                      <Button size="sm" variant="primary" disabled={!draft.text.trim()}>
                        Add note
                      </Button>
                    </div>
                  </form>
                )}
                {notes.map((n, i) => (
                  <div key={i} className="rounded-md border border-line bg-raised p-2 text-[12.5px] space-y-1">
                    <button className="text-[11.5px] text-cobalt font-mono truncate block w-full text-left hover:underline" onClick={() => setActive(n.path)}>
                      {n.path}:{n.line}
                    </button>
                    <div className="whitespace-pre-wrap">{n.text}</div>
                    <button className="text-[11px] text-faint hover:text-red" onClick={() => setNotes((all) => all.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </div>
                ))}
                {!notes.length && !draft && <div className="text-[12px] text-faint px-1">No notes yet. Click a line number in the new version to add one.</div>}
              </div>
              <ErrorNote error={err} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
