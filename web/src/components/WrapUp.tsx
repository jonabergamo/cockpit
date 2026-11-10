import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useOpenSession } from "../lib/openSession";
import { Button, ErrorNote, inputClass, Loading, Modal, Tag } from "./ui";

interface Handoff {
  id: string;
  day: string;
  session: string;
  node?: string;
  term?: string;
  title: string;
  ticket?: string;
  pr?: string;
  branch?: string;
  next: string;
  dirty: number;
  ahead: number;
  behind: number;
  createdAt: number;
}

interface NightLite {
  on: boolean;
  left: number;
}

// Opened from Today and ⌘K, so the open state lives outside both
let open = false;
const listeners = new Set<() => void>();
const set = (v: boolean) => {
  open = v;
  listeners.forEach((l) => l());
};
export const wrapUp = { open: () => set(true), close: () => set(false) };
const useOpen = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => open,
  );

const name = (h: Pick<Handoff, "ticket" | "title">) => (h.ticket && !h.title.includes(h.ticket) ? `${h.ticket} ${h.title}` : h.title);
const files = (n: number) => `${n} uncommitted ${n === 1 ? "file" : "files"}`;

function GitLine({ h }: { h: Handoff }) {
  const bits = [h.branch, h.dirty ? files(h.dirty) : "nothing uncommitted", h.ahead ? `${h.ahead} not pushed` : "", h.behind ? `${h.behind} behind` : ""].filter(Boolean);
  return (
    <div className="text-[12px] text-muted truncate">
      {bits.join(" · ")}
      {h.pr && (
        <>
          {" · "}
          <a href={h.pr} target="_blank" rel="noreferrer" className="text-cobalt hover:underline">
            PR
          </a>
        </>
      )}
    </div>
  );
}

// The end of the day: a next step for each live session, yours to edit before it's kept for tomorrow, and the
// overnight queue started on the way out when there's something waiting for it
export function WrapUpModal() {
  const isOpen = useOpen();
  const qc = useQueryClient();
  const [lines, setLines] = useState<Record<string, string>>({});
  const [drop, setDrop] = useState<Set<string>>(new Set());
  const [night, setNight] = useState(true);
  const gather = useMutation({
    mutationFn: () => api.post<Handoff[]>("/day/wrap", {}),
    onSuccess: (list) => (setLines(Object.fromEntries(list.map((h) => [h.id, h.next]))), setDrop(new Set())),
  });
  const overnight = useQuery({ queryKey: ["overnight"], queryFn: () => api.get<NightLite>("/tasks/overnight"), enabled: isOpen });
  const offerNight = !!overnight.data && !overnight.data.on && overnight.data.left > 0;
  const save = useMutation({
    mutationFn: async () => {
      const items = (gather.data ?? []).filter((h) => !drop.has(h.id)).map((h) => ({ id: h.id, next: lines[h.id] ?? h.next }));
      await api.post("/day/wrap/save", { items });
      if (offerNight && night) await api.post("/tasks/overnight", { on: true });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["handoffs"] });
      qc.invalidateQueries({ queryKey: ["overnight"] });
      wrapUp.close();
    },
  });
  // a fresh look at the sessions each time it opens
  useEffect(() => {
    if (isOpen) {
      gather.mutate();
      save.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const list = gather.data ?? [];
  const kept = list.filter((h) => !drop.has(h.id)).length;
  return (
    <Modal open={isOpen} onClose={wrapUp.close} title="Wrap up the day" wide>
      <div className="space-y-3 text-[13px]">
        <p className="text-muted">A next step for each session still open, from what it said last. Edit them, leave out the ones you're done with, and they'll be on Today tomorrow.</p>
        {gather.isPending && <Loading what="Reading each session and its worktree" rows={3} />}
        <ErrorNote error={gather.error} />
        {gather.isSuccess && !list.length && <p className="text-muted">No sessions are open, so there's nothing to hand over.</p>}
        {list.length > 0 && (
          <div className="divide-y divide-line border-y border-line max-h-[55vh] overflow-y-auto">
            {list.map((h) => {
              const off = drop.has(h.id);
              return (
                <div key={h.id} className={`py-2 space-y-1 ${off ? "opacity-50" : ""}`}>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!off}
                      aria-label={`Keep ${name(h)}`}
                      onChange={() => setDrop((d) => (d.has(h.id) ? new Set([...d].filter((x) => x !== h.id)) : new Set([...d, h.id])))}
                    />
                    <span className="font-medium truncate flex-1">{name(h)}</span>
                    {h.node && <Tag tone="faint">{h.node}</Tag>}
                  </div>
                  <input
                    value={lines[h.id] ?? h.next}
                    disabled={off}
                    onChange={(e) => setLines((l) => ({ ...l, [h.id]: e.target.value }))}
                    className={`${inputClass} w-full`}
                    aria-label={`Next step for ${name(h)}`}
                  />
                  <GitLine h={h} />
                </div>
              );
            })}
          </div>
        )}
        {offerNight && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={night} onChange={(e) => setNight(e.target.checked)} />
            Start the overnight queue too ({overnight.data!.left} {overnight.data!.left === 1 ? "task" : "tasks"} waiting)
          </label>
        )}
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={wrapUp.close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={gather.isPending || save.isPending || (!kept && !(offerNight && night))} onClick={() => save.mutate()}>
            {save.isPending ? "Saving" : offerNight && night ? "Save and start the night" : `Save ${kept} for tomorrow`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// The next morning, at the top of Today: where each session was left, and a way straight back into it
export function PickUp() {
  const qc = useQueryClient();
  const openSession = useOpenSession();
  const q = useQuery({ queryKey: ["handoffs"], queryFn: () => api.get<Handoff[]>("/day/handoffs") });
  const dismiss = useMutation({
    mutationFn: (ids: string[]) => api.post("/day/handoffs/dismiss", { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["handoffs"] }),
  });
  const go = useMutation({ mutationFn: ({ h, prompt }: { h: Handoff; prompt?: string }) => openSession({ id: h.session, term: h.term }, prompt) });
  const list = q.data ?? [];
  if (q.error) return <ErrorNote error={q.error} />;
  if (!list.length) return null;
  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-2.5">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold">Pick up where you left off</h2>
          <p className="text-[13px] text-muted">From your wrap-up {ago(list[0].createdAt)}.</p>
        </div>
        <Button variant="ghost" size="sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate(list.map((h) => h.id))}>
          Dismiss all
        </Button>
      </div>
      <div className="divide-y divide-line border-t border-line">
        {list.map((h) => (
          <div key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
            <div className="flex-1 min-w-[240px]">
              <div className="text-[13px] font-medium truncate">
                {name(h)}
                {h.node && <span className="text-faint font-normal"> · {h.node}</span>}
              </div>
              <div className="text-[13px]">{h.next}</div>
              <GitLine h={h} />
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" disabled={go.isPending} onClick={() => go.mutate({ h })}>
                Resume
              </Button>
              <Button size="sm" disabled={go.isPending} onClick={() => go.mutate({ h, prompt: h.next })} title={h.next}>
                Send this as the first message
              </Button>
              <Button variant="ghost" size="sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate([h.id])} aria-label={`Dismiss ${name(h)}`}>
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </div>
      <ErrorNote error={go.error ?? dismiss.error} />
    </section>
  );
}
