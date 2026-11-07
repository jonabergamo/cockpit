import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Schedule } from "@cockpit/shared";
import { useAgentName } from "../../lib/agent";
import { api } from "../../lib/api";
import { ago, shortPath } from "../../lib/format";
import { RootPicker, useRoots } from "../RootPicker";
import { Button, ErrorNote, inputClass, Modal } from "../ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
export const useSchedules = () => useQuery({ queryKey: ["schedules"], queryFn: () => api.get<Schedule[]>("/schedules") });

// "weekdays", "every day", or the days by name
function daysText(days: number[]) {
  if (days.length === 7) return "every day";
  if (days.join() === WEEKDAYS.join()) return "weekdays";
  if (days.join() === "0,6") return "weekends";
  return days.map((d) => DAYS[d]).join(", ");
}

// when it's next, the way you'd say it: "today at 08:30", "tomorrow at 08:30", "Mon at 08:30"
function whenText(at?: number) {
  if (!at) return "off";
  const d = new Date(at);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const time = d.toTimeString().slice(0, 5);
  if (d.toDateString() === today.toDateString()) return `today at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${DAYS[d.getDay()]} at ${time}`;
}

// Agents that start on their own, on this workspace: at a time, on the days picked, in a folder, with a prompt. The
// list, each one's next run and how its last went; and a new one.
export function Schedules({ open, onClose, workspace, workspaceName }: { open: boolean; onClose: () => void; workspace: string; workspaceName: string }) {
  const qc = useQueryClient();
  const agent = useAgentName();
  const roots = useRoots();
  const list = (useSchedules().data ?? []).filter((s) => s.canvas === workspace);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [at, setAt] = useState("08:30");
  const [days, setDays] = useState<number[]>(WEEKDAYS);
  const [err, setErr] = useState<unknown>();
  // the machine a folder is on: a worktree or folder another machine listed, or this one
  const nodeOf = (path: string) => roots.data?.worktrees.find((w) => w.path === path)?.node ?? roots.data?.remote?.find((r) => r.path === path)?.node;
  const done = () => qc.invalidateQueries({ queryKey: ["schedules"] });
  const add = useMutation({
    mutationFn: () => api.post<Schedule>("/schedules", { name, cwd, node: nodeOf(cwd), prompt, at, days, canvas: workspace }),
    onSuccess: () => {
      setName("");
      setPrompt("");
      setErr(undefined);
      done();
    },
    onError: setErr,
  });
  // shown changed at once, then as the server has it
  const patch = (id: string, p: Partial<Schedule>) => {
    qc.setQueryData<Schedule[]>(["schedules"], (ss) => ss?.map((s) => (s.id === id ? { ...s, ...p, ...(p.on === false ? { next: undefined } : {}) } : s)));
    return api.patch(`/schedules/${id}`, p).then(done, (e) => (setErr(e), done()));
  };
  const run = (id: string) => api.post(`/schedules/${id}/run`, {}).then(done, setErr);
  const remove = (id: string) => api.del(`/schedules/${id}`).then(done, setErr);
  const toggle = (d: number) => setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d].sort()));
  return (
    <Modal open={open} onClose={onClose} title={`Scheduled agents on ${workspaceName}`} wide>
      <div className="flex flex-col gap-4 text-[13px]">
        {list.length > 0 && (
          <ul className="flex flex-col divide-y divide-line border border-line rounded-md" aria-label="Schedules">
            {list.map((s) => (
              <li key={s.id} className="flex items-start gap-3 px-3 py-2" data-schedule={s.id}>
                <input type="checkbox" className="mt-1" checked={s.on} onChange={(e) => patch(s.id, { on: e.target.checked })} aria-label={`${s.name} on`} title={s.on ? "On: it runs at its time" : "Off: it doesn't run"} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{s.name}</span>
                    <span className="text-muted shrink-0">
                      {s.at}, {daysText(s.days)}
                    </span>
                  </div>
                  <div className="text-[12px] text-faint truncate" title={s.prompt}>
                    {shortPath(s.cwd)}
                    {s.node ? ` on ${s.node}` : ""} · {s.prompt}
                  </div>
                  <div className="text-[12px] text-muted" data-schedule-next>
                    Next {whenText(s.next)}
                    {s.lastRun && !s.lastError ? ` · last ran ${ago(s.lastRun)}` : ""}
                    {s.lastError && <span className="text-red"> · last time: {s.lastError}</span>}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => run(s.id)} title="Start it now, whatever its time">
                  Run now
                </Button>
                <button type="button" onClick={() => remove(s.id)} className="size-7 grid place-items-center rounded text-faint hover:text-red hover:bg-red-soft" aria-label={`Delete ${s.name}`} title="Delete this schedule">
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <div className="font-medium">{list.length ? "Another one" : `${agent}, on its own, at a time you pick`}</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, like Morning e2e" className={inputClass} aria-label="Name" />
          <RootPicker value={cwd} onChange={setCwd} />
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="What it should do, like: run the e2e suite and tell me what failed and why" className={`${inputClass} h-auto py-1.5`} aria-label="Prompt" />
          <div className="flex flex-wrap items-center gap-2">
            <input type="time" value={at} onChange={(e) => setAt(e.target.value)} className={`${inputClass} w-28`} aria-label="Time" />
            <div className="flex gap-1" role="group" aria-label="Days">
              {DAYS.map((d, i) => (
                <button key={d} type="button" onClick={() => toggle(i)} aria-pressed={days.includes(i)} className={`h-7 px-2 rounded-md border text-[12px] ${days.includes(i) ? "bg-cobalt text-on-accent border-transparent" : "border-line text-muted hover:text-ink"}`}>
                  {d}
                </button>
              ))}
            </div>
            <Button type="submit" size="sm" className="ml-auto" disabled={add.isPending}>
              {add.isPending ? "Adding" : "Add schedule"}
            </Button>
          </div>
          <p className="text-[12px] text-faint">It starts in a terminal on this workspace, from the hub, so if the hub is asleep at its time it starts once it's back, the same day.</p>
        </form>
        <ErrorNote error={err} />
      </div>
    </Modal>
  );
}
