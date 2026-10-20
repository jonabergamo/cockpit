import { useEffect, useRef } from "react";
import type { Job } from "../lib/queries";
import { Spinner, Tag } from "./ui";

// strips ANSI colour codes, the job output is shown as plain text
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

export function JobLog({ job, onDone }: { job: Job; onDone?: () => void }) {
  const pre = useRef<HTMLPreElement>(null);
  const done = job.code !== undefined;

  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [job.output]);

  useEffect(() => {
    if (done) onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  return (
    <div className="border border-line rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 h-8 bg-ground text-[13px]">
        {!done && <Spinner />}
        <span className="font-medium">{job.label}</span>
        {done && <Tag tone={job.code === 0 ? "green" : "red"}>{job.code === 0 ? "done" : `failed (${job.code})`}</Tag>}
      </div>
      <pre ref={pre} className="font-mono text-[12px] whitespace-pre-wrap break-words max-h-56 overflow-y-auto px-2.5 py-2 text-muted">
        {plain(job.output) || "Starting"}
      </pre>
    </div>
  );
}
