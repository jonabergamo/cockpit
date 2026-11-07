import { type Node, type NodeProps } from "@xyflow/react";
import { useOpenEditor } from "../OpenEditor";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useAgentName } from "../../lib/agent";
import { api, qs } from "../../lib/api";
import { ago } from "../../lib/format";
import { DiffReview } from "../LazyDiffReview";
import { useActions } from "./context";
import { useFit } from "./fit";
import { Ports } from "./LinkEdge";

// what it shows the branch of: a terminal (its repo is wherever it sits) or a ticket's worktree
export type ChangesFrom = { term: string; node?: string; label: string; session?: string } | { root: string; node?: string; label: string };
export type ChangesData = { from?: ChangesFrom; fit?: boolean };
export type ChangesCardNode = Node<ChangesData, "changes">;

interface BranchFile {
  path: string;
  status: string;
  added?: number;
  removed?: number;
  committed: boolean;
}
interface Branch {
  root: string;
  branch: string;
  base?: string;
  ahead: number;
  behind: number;
  commits: { sha: string; at: number; subject: string }[];
  files: BranchFile[];
  more: number;
}

const tone: Record<string, string> = { A: "text-green", U: "text-green", D: "text-red", M: "text-amber" };
const MAX_LINES = 400;

function Diff({ root, node, path }: { root: string; node?: string; path: string }) {
  const q = useQuery({ queryKey: ["branchdiff", root, node, path], queryFn: () => api.get<string>(`/code/fs/branchdiff${qs({ root, node, path })}`) });
  if (q.isLoading) return <div className="px-3 py-1 text-faint">Reading the diff</div>;
  const lines = (q.data ?? "").split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  if (!lines.some(Boolean)) return <div className="px-3 py-1 text-faint">No text changes to show (a binary file, or only its mode changed).</div>;
  return (
    <pre className="nowheel max-h-72 overflow-auto bg-ground/60 border-y border-line font-mono text-[11px] leading-[1.45] py-1">
      {lines.slice(0, MAX_LINES).map((l, i) => (
        <div key={i} className={`px-3 whitespace-pre ${l.startsWith("+") ? "bg-green-soft text-green" : l.startsWith("-") ? "bg-red-soft text-red" : l.startsWith("@@") ? "text-cobalt" : "text-muted"}`}>
          {l || " "}
        </div>
      ))}
      {lines.length > MAX_LINES && <div className="px-3 text-faint">{lines.length - MAX_LINES} more lines, open it in Code to see them all</div>}
    </pre>
  );
}

function FileRow({ f, root, node }: { f: BranchFile; root: string; node?: string }) {
  const [open, setOpen] = useState(false);
  const slash = f.path.lastIndexOf("/");
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-3 h-6 text-left hover:bg-ground" title={f.path} aria-expanded={open}>
        <span className={`w-3 shrink-0 font-mono font-semibold ${tone[f.status] ?? "text-muted"}`}>{f.status}</span>
        <span className="truncate flex-1 min-w-0">
          <span className="text-faint">{slash >= 0 ? f.path.slice(0, slash + 1) : ""}</span>
          {f.path.slice(slash + 1)}
        </span>
        {!f.committed && <span className="size-1.5 rounded-full bg-amber shrink-0" title="Not committed yet" />}
        {f.added !== undefined && <span className="text-green tabular-nums shrink-0">+{f.added}</span>}
        {f.removed !== undefined && <span className="text-red tabular-nums shrink-0">−{f.removed}</span>}
      </button>
      {open && <Diff root={root} node={node} path={f.path} />}
    </div>
  );
}

// The branch of whatever it's linked to, against where it split off: every file it changes (a dot on the ones not
// committed yet), each one's diff a click away, and its commits. It keeps itself up to date while it's on screen.
export function ChangesCard({ id, data, selected }: NodeProps<ChangesCardNode>) {
  const a = useActions();
  const agent = useAgentName();
  const navigate = useNavigate();
  const [commits, setCommits] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const from = data.from;
  const term = from && "term" in from ? from.term : undefined;
  // a terminal's repo is wherever it's sitting right now
  const where = useQuery({ queryKey: ["term-changes", term], queryFn: () => api.get<{ root: string | null }>(`/code/terms/${term}/changes`), enabled: !!term, refetchInterval: 10_000 });
  const root = from && "root" in from ? from.root : (where.data?.root ?? undefined);
  const node = from?.node && from.node !== "local" ? from.node : undefined;
  const b = useQuery({ queryKey: ["branch", root, node], queryFn: () => api.get<Branch>(`/code/fs/branch${qs({ root, node })}`), enabled: !!root, refetchInterval: 5000 });
  const d = b.data;
  const open = d?.files.filter((f) => !f.committed).length ?? 0;
  const added = d?.files.reduce((s, f) => s + (f.added ?? 0), 0) ?? 0;
  const removed = d?.files.reduce((s, f) => s + (f.removed ?? 0), 0) ?? 0;

  const empty = !from
    ? "Draw a line from this card to a terminal or a ticket, and it shows that branch's changes."
    : term && where.data && !where.data.root
      ? "That terminal isn't in a git repo cockpit knows."
      : b.error
        ? `Couldn't read the branch: ${b.error instanceof Error ? b.error.message : b.error}`
        : undefined;

  const fit = useFit({ id, selected, fit: data.fit, max: 640, minWidth: 300, minHeight: 120 });
  const editor = useOpenEditor();
  const editorFailed = editor.error ?? (editor.job && editor.job.code !== undefined && editor.job.code !== 0 ? new Error(editor.job.output.trim().split("\n").pop() || `it ended with ${editor.job.code}`) : undefined);
  return (
    <div className={`w-full flex flex-col rounded-lg border bg-panel shadow-lg overflow-hidden text-[12px] ${selected ? "border-cobalt" : "border-line"}`} style={fit.style} data-changes={id}>
      {fit.resizer}
      <Ports />
      <div className="card-handle cursor-grab active:cursor-grabbing flex items-center gap-2 h-8 pl-2.5 pr-1 bg-raised border-b border-line shrink-0" onDoubleClick={() => a.bringUp(id)} title="Drag to move, double-click to bring it up">
        <span className="font-medium">Changes</span>
        {d ? (
          <span className="truncate text-muted" title={d.root}>
            {d.branch}
            {d.base && d.branch !== d.base && (
              <span className="text-faint">
                {" "}
                · {d.ahead} ahead{d.behind ? `, ${d.behind} behind` : ""} {d.base}
              </span>
            )}
          </span>
        ) : (
          from && <span className="truncate text-faint">{from.label}</span>
        )}
        <button type="button" onClick={() => a.removeCard(id)} className="nodrag ml-auto size-6 grid place-items-center rounded text-faint hover:text-red hover:bg-ground" title="Take this card off the canvas" aria-label="Remove changes card">
          ×
        </button>
      </div>
      {empty || !d ? (
        <div className="flex-auto grid place-items-center px-6 py-8 text-center text-muted">{empty ?? "Reading the branch"}</div>
      ) : (
        <>
          <div className="flex items-center gap-3 px-3 h-7 border-b border-line text-muted shrink-0">
            <span>
              {d.files.length + d.more} {d.files.length + d.more === 1 ? "file" : "files"}
            </span>
            <span className="text-green tabular-nums">+{added}</span>
            <span className="text-red tabular-nums">−{removed}</span>
            {open > 0 && (
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-amber" />
                {open} not committed
              </span>
            )}
            <div className="ml-auto flex items-center gap-0.5 nodrag">
              {!node && d.files.some((f) => !f.committed) && (
                <button type="button" onClick={() => setReviewing(true)} className="h-6 px-1.5 rounded text-cobalt hover:bg-ground" title={`Read what isn't committed and leave notes for ${agent} on specific lines`}>
                  Review
                </button>
              )}
              {!node && (
                <button type="button" onClick={() => navigate({ to: "/code", search: { root: d.root } })} className="h-6 px-1.5 rounded text-cobalt hover:bg-ground">
                  Code
                </button>
              )}
              <button
                type="button"
                disabled={editor.pending}
                onClick={() => editor.open(d.root, node)}
                className="h-6 px-1.5 rounded text-cobalt hover:bg-ground disabled:opacity-50 flex items-center gap-1"
                title={`Open ${d.root}${node ? ` on ${node}` : ""} in ${editor.label}`}
                data-open-editor
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3.25c0 .4-.35.75-.75.75h-8c-.4 0-.75-.35-.75-.75v-8c0-.4.35-.75.75-.75H6.5" />
                </svg>
                {editor.label}
              </button>
            </div>
          </div>
          <div className="nowheel flex-auto min-h-0 overflow-y-auto py-1">
            {editorFailed && (
              <div className="px-3 py-1 text-red" data-open-editor-error>
                Couldn't open {editor.label}: {editorFailed instanceof Error ? editorFailed.message : String(editorFailed)}
              </div>
            )}
            {d.files.length ? d.files.map((f) => <FileRow key={f.path} f={f} root={d.root} node={node} />) : <div className="px-3 py-2 text-muted">Nothing changed on this branch yet.</div>}
            {d.more > 0 && <div className="px-3 py-1 text-faint">and {d.more} more files</div>}
          </div>
          {d.commits.length > 0 && (
            <div className="border-t border-line shrink-0">
              <button type="button" onClick={() => setCommits(!commits)} className="w-full flex items-center gap-1.5 px-3 h-7 text-left text-muted hover:bg-ground" aria-expanded={commits}>
                <span className={`text-[9px] transition-transform ${commits ? "rotate-90" : ""}`}>▶</span>
                {d.commits.length === 50 ? "50+ commits" : d.commits.length === 1 ? "1 commit" : `${d.commits.length} commits`}
                <span className="ml-auto text-faint truncate">{d.commits[0].subject}</span>
              </button>
              {commits && (
                <div className="nowheel max-h-40 overflow-y-auto pb-1">
                  {d.commits.map((c) => (
                    <div key={c.sha} className="flex items-center gap-2 px-3 h-6">
                      <span className="font-mono text-faint shrink-0">{c.sha}</span>
                      <span className="truncate flex-1">{c.subject}</span>
                      <span className="text-faint shrink-0">{ago(c.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {reviewing && d && <DiffReview root={d.root} sessionId={from && "session" in from ? from.session : undefined} onClose={() => setReviewing(false)} />}
    </div>
  );
}
