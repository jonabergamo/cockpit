import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Change, UpdateStatus } from "@cockpit/shared";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useLive } from "../lib/live";
import { useJobs, type Job } from "../lib/queries";
import { JobLog } from "./JobLog";
import { Button, ErrorNote, Modal, Tag } from "./ui";

export const useUpdate = () => {
  const qc = useQueryClient();
  useLive((ev) => ev.type === "update" && qc.setQueryData(["update"], (old: UpdateStatus | undefined) => ({ ...old, ...ev.status, nodes: ev.status.nodes ?? old?.nodes })), [qc]);
  return useQuery({ queryKey: ["update"], queryFn: () => api.get<UpdateStatus>("/update"), staleTime: 10 * 60_000, refetchInterval: 20 * 60_000 });
};

const behindOf = (s?: UpdateStatus) => Math.max(s?.behind ?? 0, ...(s?.nodes ?? []).map((n) => n.behind));

const SHOWN: Record<string, string> = { feat: "New", fix: "Fixed", perf: "Fixed" };
// cockpit is written in lower case, even at the start
const cap = (s: string) => (/^cockpit\b/.test(s) ? s : s.charAt(0).toUpperCase() + s.slice(1));

// Commits as a changelog: what's new and what's fixed, each in its own words, and how many smaller changes besides
export function ChangeList({ changes }: { changes: Change[] }) {
  const groups = ["New", "Fixed"].map((g) => [g, changes.filter((c) => SHOWN[c.type] === g)] as const).filter(([, l]) => l.length);
  const rest = changes.filter((c) => !SHOWN[c.type]).length;
  return (
    <div className="space-y-4">
      {groups.map(([name, list]) => (
        <section key={name} className="space-y-2">
          <h3 className="text-[12px] text-faint uppercase tracking-wide">{name}</h3>
          <ul className="space-y-2.5">
            {list.map((c) => (
              <li key={c.sha} className="text-[13px]">
                <div className="flex items-start gap-2">
                  {c.scope && <Tag tone="faint">{c.scope}</Tag>}
                  <span className="font-medium">{cap(c.subject)}</span>
                </div>
                {c.detail && <p className="text-muted mt-0.5 leading-relaxed">{c.detail}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!groups.length && <p className="text-[13px] text-muted">Only behind-the-scenes changes.</p>}
      {rest > 0 && !!groups.length && (
        <p className="text-[12px] text-faint">
          And {rest} smaller change{rest === 1 ? "" : "s"}: docs, tests and tidying.
        </p>
      )}
    </div>
  );
}

function UpdateDialog({ s, onClose }: { s: UpdateStatus; onClose: () => void }) {
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string>();
  const job = useJobs().data?.find((j) => j.id === jobId);
  const go = useMutation({
    mutationFn: () => api.post<Job>("/update"),
    onSuccess: async (j) => {
      await qc.invalidateQueries({ queryKey: ["jobs"] });
      setJobId(j.id);
    },
  });
  const check = useMutation({ mutationFn: () => api.get<UpdateStatus>("/update?force=1"), onSuccess: (n) => qc.setQueryData(["update"], n) });
  const behindNodes = (s.nodes ?? []).filter((n) => n.behind || n.blocked || n.error);
  const failed = job?.code !== undefined && job.code !== 0;
  return (
    <Modal open onClose={onClose} title={s.behind ? `Update cockpit: ${s.behind} new change${s.behind === 1 ? "" : "s"}` : "Updates"} wide>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto">
        {s.behind ? <ChangeList changes={s.changes} /> : <p className="text-[13px] text-muted">This machine is up to date{s.branch ? ` with ${s.branch}` : ""}. Last checked {ago(s.checkedAt)}.</p>}
        {!!behindNodes.length && (
          <ul className="text-[13px] text-muted space-y-1">
            {behindNodes.map((n) => (
              <li key={n.machine}>
                <span className="text-ink">{n.machine}</span>: {n.error ?? n.blocked ?? `${n.behind} behind`}
              </li>
            ))}
          </ul>
        )}
        {s.blocked && <p className="text-[13px] text-amber">It can't update itself here: {s.blocked}.</p>}
        {s.error && <p className="text-[13px] text-amber">{s.error}</p>}
        {job && <JobLog job={job} />}
        {job?.code === 0 && <p className="text-[13px] text-green">{s.service ? "Updated. cockpit is restarting, and this page reloads by itself." : "Updated. Restart cockpit to run the new version."}</p>}
        <ErrorNote error={go.error ?? check.error} />
      </div>
      <div className="flex items-center gap-2 mt-4">
        <Button variant="ghost" onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending ? "Checking" : "Check again"}
        </Button>
        <span className="flex-1" />
        <Button onClick={onClose}>{job ? "Close" : "Later"}</Button>
        {!!s.behind && !s.blocked && (!job || failed) && (
          <Button variant="primary" onClick={() => go.mutate()} disabled={go.isPending}>
            {go.isPending ? "Starting" : failed ? "Try again" : "Update now"}
          </Button>
        )}
      </div>
    </Modal>
  );
}

// In the sidebar when there's an update, opening what it brings
export function UpdateNotice() {
  const s = useUpdate().data;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    addEventListener("cockpit:updates", show);
    return () => removeEventListener("cockpit:updates", show);
  }, []);
  const n = behindOf(s);
  return (
    <>
      {n > 0 && (
        <button onClick={() => setOpen(true)} className="mx-2 mb-2 px-2.5 py-2 rounded-md bg-cobalt-soft text-cobalt text-[12px] font-medium text-left hover:brightness-110" title="What it brings, and updating">
          {s?.restarting ? "Updated, restarting" : `Update available · ${n} change${n === 1 ? "" : "s"}`}
        </button>
      )}
      {open && s && <UpdateDialog s={s} onClose={() => setOpen(false)} />}
    </>
  );
}

const SEEN = "cockpit.seenCommit";
const read = () => {
  try {
    return localStorage.getItem(SEEN) ?? undefined;
  } catch {
    return undefined;
  }
};
const write = (v: string) => {
  try {
    localStorage.setItem(SEEN, v);
  } catch {}
};

// After an update, once per device: what changed since the version this device last saw
export function WhatsNew() {
  const [changes, setChanges] = useState<Change[]>();
  const [commit, setCommit] = useState<string>();
  useEffect(() => {
    void (async () => {
      const v = await api.get<{ commit?: string }>("/version").catch(() => undefined);
      if (!v?.commit) return;
      const seen = read();
      // the first time here there's nothing to compare with
      if (!seen) return write(v.commit);
      if (seen === v.commit) return;
      const list = await api.get<Change[]>(`/changelog?from=${seen}&to=${v.commit}`).catch(() => []);
      if (list.some((c) => c.type === "feat" || c.type === "fix" || c.type === "perf")) (setCommit(v.commit), setChanges(list));
      else write(v.commit);
    })();
  }, []);
  if (!changes || !commit) return null;
  const close = () => (write(commit), setChanges(undefined));
  return (
    <Modal open onClose={close} title="What's new in cockpit" wide>
      <div className="max-h-[70vh] overflow-y-auto">
        <ChangeList changes={changes} />
      </div>
      <div className="flex justify-end mt-4">
        <Button variant="primary" onClick={close}>
          Got it
        </Button>
      </div>
    </Modal>
  );
}
