import { DiffEditor } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, qs } from "../lib/api";
import { useEditorFont } from "../lib/fonts";
import { ago } from "../lib/format";
import { editorTheme } from "../lib/monaco";
import "../lib/monaco";
import { Spinner } from "./ui";

interface Commit {
  sha: string;
  parents: string[];
  at: number;
  author: string;
  refs: string[];
  subject: string;
}
interface CommitFile {
  path: string;
  status: string;
  from?: string;
}
interface Side {
  content: string;
  binary: boolean;
  tooLarge: boolean;
}

// One row of the graph: the lanes coming in from above, the commit's lane, and the lanes leaving below.
interface Row {
  col: number;
  top: [number, number][]; // from lane, to lane, top edge to the dot's height
  bottom: [number, number][]; // middle to the bottom edge
  width: number;
}

// Lanes the way VS Code and git log --graph draw them: each lane waits for a commit, a commit
// takes over the lane that waited for it, its first parent keeps the lane and other parents get new ones.
function layout(commits: Commit[]): Row[] {
  let lanes: (string | null)[] = [];
  return commits.map((c) => {
    let col = lanes.indexOf(c.sha);
    if (col < 0) {
      col = lanes.indexOf(null);
      if (col < 0) col = lanes.length;
    }
    const top: [number, number][] = [];
    lanes.forEach((sha, i) => {
      if (!sha) return;
      if (sha === c.sha) top.push([i, col]);
      else top.push([i, i]);
    });
    const next = lanes.map((sha) => (sha === c.sha ? null : sha));
    next[col] = c.parents[0] ?? null;
    const bottom: [number, number][] = [];
    c.parents.slice(1).forEach((p) => {
      let j = next.indexOf(p);
      if (j < 0) {
        j = next.indexOf(null);
        if (j < 0) j = next.length;
        next[j] = p;
      }
      bottom.push([col, j]);
    });
    next.forEach((sha, i) => {
      if (!sha) return;
      if (i === col) bottom.push([col, col]);
      else if (!bottom.some(([, to]) => to === i)) bottom.push([i, i]);
    });
    while (next.length && next[next.length - 1] === null) next.pop();
    const width = Math.max(lanes.length, next.length, col + 1);
    lanes = next;
    return { col, top, bottom, width };
  });
}

const LANE = 10;
const COLORS = ["var(--cobalt)", "var(--green)", "var(--amber)", "var(--red)", "var(--muted)"];
const color = (i: number) => COLORS[i % COLORS.length];
const x = (i: number) => LANE / 2 + 2 + i * LANE;

function Graph({ row, height, maxWidth }: { row: Row; height: number; maxWidth: number }) {
  const mid = 13;
  return (
    <svg width={x(maxWidth - 1) + LANE / 2 + 2} height={height} className="shrink-0 overflow-visible" aria-hidden>
      {row.top.map(([from, to], k) => (
        <path key={`t${k}`} d={from === to ? `M${x(from)} 0V${mid}` : `M${x(from)} 0C${x(from)} ${mid / 2} ${x(to)} ${mid / 2} ${x(to)} ${mid}`} stroke={color(from)} strokeWidth={1.5} fill="none" />
      ))}
      {row.bottom.map(([from, to], k) => (
        <path key={`b${k}`} d={from === to ? `M${x(from)} ${mid}V${height}` : `M${x(from)} ${mid}C${x(from)} ${height} ${x(to)} ${mid} ${x(to)} ${height}`} stroke={color(to)} strokeWidth={1.5} fill="none" />
      ))}
      <circle cx={x(row.col)} cy={mid} r={3.5} fill="var(--panel)" stroke={color(row.col)} strokeWidth={2} />
    </svg>
  );
}

const STATUS: Record<string, string> = { A: "text-green", D: "text-red", M: "text-amber", R: "text-cobalt", C: "text-cobalt" };

function Refs({ refs }: { refs: string[] }) {
  if (!refs.length) return null;
  const names = refs.map((r) => r.replace(/^HEAD -> /, "")).filter((r) => r !== "HEAD" && !r.endsWith("/HEAD"));
  return (
    <>
      {names.slice(0, 3).map((r) => (
        <span key={r} className={`shrink-0 max-w-[110px] truncate rounded px-1 text-[10.5px] leading-4 ${r.startsWith("tag: ") ? "bg-amber-soft text-amber" : r.includes("/") ? "bg-ground text-muted" : "bg-cobalt-soft text-cobalt"}`} title={r}>
          {r.replace(/^tag: /, "")}
        </span>
      ))}
    </>
  );
}

function CommitFiles({ root, sha, depth, onOpen }: { root: string; sha: string; depth: number; onOpen: (f: CommitFile) => void }) {
  const q = useQuery({ queryKey: ["commit", root, sha], queryFn: () => api.get<{ message: string; files: CommitFile[] }>(`/code/fs/commit${qs({ root, sha })}`), staleTime: Infinity });
  const pad = { paddingLeft: depth };
  if (q.isLoading)
    return (
      <div className="py-1 text-[12px] text-faint flex items-center gap-1.5" style={pad}>
        <Spinner className="size-3" /> Reading the commit
      </div>
    );
  if (q.error) return <div className="py-1 text-[12px] text-red" style={pad}>{(q.error as Error).message}</div>;
  const body = q.data!.message.split("\n").slice(1).join("\n").trim();
  return (
    <div className="pb-1">
      {body && <div className="text-[12px] text-muted whitespace-pre-wrap pr-3 pb-1 line-clamp-6" style={pad}>{body}</div>}
      {q.data!.files.map((f) => {
        const slash = f.path.lastIndexOf("/");
        return (
          <button key={f.path} onClick={() => onOpen(f)} className="w-full flex items-center gap-1.5 pr-3 h-[22px] text-[12.5px] hover:bg-ground text-left" style={pad} title={f.from ? `${f.from} → ${f.path}` : f.path}>
            <span className="truncate text-ink">{f.path.slice(slash + 1)}</span>
            <span className="truncate text-faint text-[11.5px] flex-1">{slash > 0 ? f.path.slice(0, slash) : ""}</span>
            <span className={`font-mono text-[11px] shrink-0 ${STATUS[f.status] ?? "text-muted"}`}>{f.status}</span>
          </button>
        );
      })}
      {!q.data!.files.length && <div className="text-[12px] text-faint" style={pad}>No file changes.</div>}
    </div>
  );
}

// The commit list with its graph, newest first. A commit opens to its files; a file opens its diff.
export function GitHistory({ root }: { root: string }) {
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState<string>();
  const [diff, setDiff] = useState<{ commit: Commit; file: CommitFile }>();
  const q = useQuery({
    queryKey: ["history", root, limit],
    queryFn: () => api.get<Commit[]>(`/code/fs/history${qs({ root, limit })}`),
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
  const commits = q.data ?? [];
  const rows = useMemo(() => layout(commits), [commits]);
  const maxWidth = Math.min(6, Math.max(1, ...rows.map((r) => r.width)));
  useEffect(() => setOpen(undefined), [root]);

  if (q.isLoading) return <div className="px-3 py-2 text-[13px] text-muted">Reading git</div>;
  if (!commits.length) return <div className="px-3 py-2 text-[13px] text-muted">No commits yet.</div>;

  return (
    <div className="py-0.5">
      {commits.map((c, i) => {
        const row = rows[i];
        const expanded = open === c.sha;
        return (
          <div key={c.sha}>
            <button
              onClick={() => setOpen(expanded ? undefined : c.sha)}
              className={`w-full flex items-center gap-1.5 pr-3 h-[26px] text-left hover:bg-ground ${expanded ? "bg-ground" : ""}`}
              title={`${c.subject}\n${c.author} · ${new Date(c.at).toLocaleString()} · ${c.sha.slice(0, 8)}`}
            >
              <Graph row={row} height={26} maxWidth={maxWidth} />
              <span className="truncate text-[12.5px] text-ink flex-1 min-w-0">{c.subject}</span>
              <Refs refs={c.refs} />
              <span className="text-[11px] text-faint shrink-0">{ago(c.at)}</span>
            </button>
            {expanded && <CommitFiles root={root} sha={c.sha} depth={x(maxWidth - 1) + LANE / 2 + 8} onOpen={(file) => setDiff({ commit: c, file })} />}
          </div>
        );
      })}
      {commits.length >= limit && (
        <button onClick={() => setLimit((n) => n + 100)} className="w-full text-[12px] text-cobalt py-1.5 hover:bg-ground" disabled={q.isFetching}>
          {q.isFetching ? "Loading" : "Load older commits"}
        </button>
      )}
      {diff && <CommitDiff root={root} commit={diff.commit} file={diff.file} onClose={() => setDiff(undefined)} />}
    </div>
  );
}

function CommitDiff({ root, commit, file, onClose }: { root: string; commit: Commit; file: CommitFile; onClose: () => void }) {
  const editorFont = useEditorFont();
  const q = useQuery({
    queryKey: ["commit-file", root, commit.sha, file.path],
    queryFn: () => api.get<{ before: Side; after: Side }>(`/code/fs/commit${qs({ root, sha: commit.sha, path: file.path, from: file.from })}`),
    staleTime: Infinity,
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  const odd = q.data && (q.data.before.binary || q.data.after.binary ? "Binary file, no text diff." : q.data.before.tooLarge || q.data.after.tooLarge ? "Too large to show." : "");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-[1400px] h-full bg-panel border border-line rounded-lg shadow-xl flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-4 h-11 border-b border-line shrink-0">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium truncate">
              {file.from ? `${file.from} → ` : ""}
              {file.path}
            </div>
            <div className="text-[11.5px] text-muted truncate">
              {commit.subject} · {commit.author} · {ago(commit.at)} · <span className="font-mono">{commit.sha.slice(0, 8)}</span>
            </div>
          </div>
          <button onClick={onClose} className="size-7 rounded text-faint hover:text-ink hover:bg-ground" aria-label="Close the diff">
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0">
          {q.isLoading ? (
            <div className="p-4 text-[13px] text-muted">Reading the file</div>
          ) : q.error ? (
            <div className="p-4 text-[13px] text-red">{(q.error as Error).message}</div>
          ) : odd ? (
            <div className="p-4 text-[13px] text-muted">{odd}</div>
          ) : (
            <DiffEditor
              original={q.data!.before.content}
              modified={q.data!.after.content}
              originalModelPath={`commit://${commit.sha}^/${file.from ?? file.path}`}
              modifiedModelPath={`commit://${commit.sha}/${file.path}`}
              theme={editorTheme()}
              options={{ readOnly: true, renderSideBySide: window.innerWidth > 1100, hideUnchangedRegions: { enabled: true }, minimap: { enabled: false }, scrollBeyondLastLine: false, ...editorFont }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
