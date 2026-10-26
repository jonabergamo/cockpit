import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { useJobs } from "../lib/queries";
import { Button, ErrorNote, inputClass, Markdown, Modal, Spinner } from "./ui";
import { useAgentName } from "../lib/agent";

// Opened from ⌘K with the question typed there.
let state: { open: boolean; question?: string } = { open: false };
const listeners = new Set<() => void>();
const set = (s: typeof state) => {
  state = s;
  listeners.forEach((l) => l());
};
export const askCockpit = { open: (question: string) => set({ open: true, question }), close: () => set({ open: false }) };
const useAsk = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => state,
  );

// A question about your own work, answered by Claude from cockpit's index: sessions, the Board and your tickets.
export function AskPanel() {
  const agent = useAgentName();
  const s = useAsk();
  const navigate = useNavigate();
  const jobs = useJobs();
  const [question, setQuestion] = useState("");
  const [jobId, setJobId] = useState<string>();
  const [err, setErr] = useState<unknown>();
  const job = jobs.data?.find((j) => j.id === jobId);
  const done = job?.code !== undefined;

  const send = async (q: string) => {
    setErr(undefined);
    setJobId(undefined);
    try {
      setJobId((await api.post<{ id: string }>("/claude/question", { question: q })).id);
    } catch (e) {
      setErr(e);
    }
  };
  useEffect(() => {
    if (!s.open || !s.question) return;
    setQuestion(s.question);
    send(s.question);
  }, [s.open, s.question]);

  // links in the answer point at cockpit's own pages
  const follow = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!href?.startsWith("/")) return;
    e.preventDefault();
    askCockpit.close();
    navigate({ href });
  };

  return (
    <Modal open={s.open} onClose={askCockpit.close} title="Ask cockpit" wide>
      <form
        className="flex gap-2 mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) send(question.trim());
        }}
      >
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="When did I last touch the basket total?" className={`${inputClass} flex-1`} autoFocus />
        <Button variant="primary" disabled={!!jobId && !done}>
          Ask
        </Button>
      </form>
      <ErrorNote error={err} />
      {jobId && !done && (
        <div className="flex items-center gap-2 text-[13px] text-muted py-2">
          <Spinner /> Reading your sessions, the Board and your tickets
        </div>
      )}
      {job && done && job.code !== 0 && <ErrorNote error={new Error(job.output.trim().split("\n").slice(-3).join("\n") || `${agent} stopped without an answer`)} />}
      {job && done && job.code === 0 && (
        <div className="text-[14px] max-h-[60vh] overflow-y-auto" onClick={follow}>
          <Markdown>{job.output.trim()}</Markdown>
        </div>
      )}
      <p className="text-[12px] text-faint mt-3">{agent} answers from what cockpit has indexed on this machine, and links what it used.</p>
    </Modal>
  );
}
