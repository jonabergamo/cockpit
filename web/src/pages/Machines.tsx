import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Machine, Session, TermInfo, Worktree } from "@cockpit/shared";
import { LOOK, type MachinesRes } from "../components/Machines";
import { Button, Empty, ErrorNote, Loading, PageHeader, Tag } from "../components/ui";
import { api } from "../lib/api";
import { ago, shortPath } from "../lib/format";
import { useLive, useLiveSessions } from "../lib/live";
import { useWorktrees } from "../lib/queries";
import { statusLook } from "../lib/status";

// Every machine this cockpit works with and what's on each one right now: whether it can be reached, its
// terminals, the sessions going on it and its worktrees. Adding, pairing and where work goes stay in Settings.
export function MachinesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["machines"], queryFn: () => api.get<MachinesRes>("/machines") });
  useLive((ev) => ev.type === "machines" && qc.setQueryData<MachinesRes>(["machines"], (d) => d && { ...d, machines: ev.machines }), [qc]);
  const terms = useQuery({ queryKey: ["terms"], queryFn: () => api.get<TermInfo[]>("/code/terms"), refetchInterval: 15_000 });
  const worktrees = useWorktrees();
  const sessions = useLiveSessions();

  const on = <T extends { node?: string }>(list: T[] | undefined, id: string) => (list ?? []).filter((x) => (x.node && x.node !== "local" ? x.node : "local") === id);
  const d = q.data;

  return (
    <div className="space-y-4">
      <PageHeader title="Machines" sub="Where your work runs, and what's going on each machine right now.">
        <Link to="/settings" search={{ tab: "machines" }}>
          <Button>Add or set up</Button>
        </Link>
      </PageHeader>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {d && (
        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,380px),1fr))]">
          <MachineCard
            name={d.here?.hostname ?? "This machine"}
            role={d.role === "hub" ? "hub, this one" : "this one"}
            info={d.here}
            terms={on(terms.data, "local")}
            sessions={on(sessions, "local")}
            worktrees={on(worktrees.data, "local")}
          />
          {d.machines.map((m) => (
            <MachineCard key={m.id} machine={m} name={m.name} role="node" info={m.info} terms={on(terms.data, m.id)} sessions={on(sessions, m.id)} worktrees={on(worktrees.data, m.id)} />
          ))}
        </div>
      )}
      {d && !d.machines.length && <Empty>Only this machine so far. Settings → Machines adds another one as a node.</Empty>}
    </div>
  );
}

function MachineCard({
  machine,
  name,
  role,
  info,
  terms,
  sessions,
  worktrees,
}: {
  machine?: Machine;
  name: string;
  role: string;
  info?: Machine["info"];
  terms: TermInfo[];
  sessions: Session[];
  worktrees: Worktree[];
}) {
  const state = machine?.state ?? "up";
  const look = LOOK[state];
  const running = terms.filter((t) => !t.parent && (t.state ?? (t.exited ? "exited" : "running")) !== "exited");
  const live = sessions.filter((s) => s.status === "busy" || s.status === "waiting").sort((a, b) => (a.status === "waiting" ? -1 : 0) - (b.status === "waiting" ? -1 : 0) || b.updatedAt - a.updatedAt);
  const waiting = live.filter((s) => s.status === "waiting").length;
  const dirty = worktrees.filter((w) => !w.main && w.dirty).length;
  const retry = () => machine && api.post(`/machines/${machine.id}/retry`);

  return (
    <section className={`bg-panel border rounded-lg flex flex-col ${state === "up" ? "border-line" : "border-red/40"}`}>
      <header className="px-4 pt-3 pb-2 space-y-1">
        <div className="flex items-center gap-2">
          <span className={`size-2.5 rounded-full shrink-0 ${state === "up" ? "bg-green" : state === "connecting" ? "bg-amber animate-pulse" : "bg-red"}`} />
          <h2 className="font-semibold text-[15px] truncate flex-1">{name}</h2>
          <span className="text-[12px] text-faint">{role}</span>
          {machine && <Tag tone={look.tone}>{look.label}</Tag>}
        </div>
        <div className="text-[12px] text-muted truncate">
          {[info?.platform, info?.gpu ? "GPU" : undefined, info?.version ? `cockpit ${info.version}` : undefined, machine?.rtt !== undefined && state === "up" ? `${machine.rtt} ms` : undefined].filter(Boolean).join(" · ") || machine?.url}
        </div>
        {machine && state !== "up" && (
          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-red flex-1 min-w-0 truncate" title={machine.error}>
              {state === "connecting" ? "Trying" : "Out of reach"} since {ago(machine.since)}
              {machine.error ? `: ${machine.error}` : ""}
            </span>
            <Button size="sm" variant="ghost" onClick={retry}>
              Try now
            </Button>
          </div>
        )}
      </header>

      <div className="grid grid-cols-3 border-y border-line text-center">
        <Stat to="/terminals" value={running.length} label={running.length === 1 ? "terminal" : "terminals"} />
        <Stat to="/sessions" value={live.length} label="working" note={waiting ? `${waiting} waiting for you` : undefined} />
        <Stat to="/tickets" search={{ tab: "worktrees" }} value={worktrees.filter((w) => !w.main).length} label="worktrees" note={dirty ? `${dirty} with changes` : undefined} />
      </div>

      <div className="flex-1">
        {live.length ? (
          <ul className="divide-y divide-line">
            {live.slice(0, 5).map((s) => {
              const st = statusLook(s.status, s.waitingFor, s.background);
              return (
                <li key={s.id}>
                  <Link to="/sessions/$id" params={{ id: s.id }} className="flex items-center gap-2.5 px-4 py-2 hover:bg-ground">
                    <span className={`size-2 rounded-full shrink-0 ${st.dot} ${s.status === "busy" ? "animate-pulse" : ""}`} />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-[13px] font-medium">{s.title ?? s.lastPrompt ?? s.id.slice(0, 8)}</div>
                      <div className="truncate text-[12px] text-muted">
                        {shortPath(s.cwd)}
                        {s.branch ? ` on ${s.branch}` : ""}
                      </div>
                    </div>
                    <span className={`text-[12px] shrink-0 ${st.text}`}>{st.label}</span>
                  </Link>
                </li>
              );
            })}
            {live.length > 5 && <li className="px-4 py-2 text-[12px] text-faint">and {live.length - 5} more</li>}
          </ul>
        ) : (
          <div className="px-4 py-5 text-[13px] text-faint text-center">{state === "up" ? "Nothing working here right now." : "Can't see what's on it until it's back."}</div>
        )}
      </div>
    </section>
  );
}

function Stat({ to, search, value, label, note }: { to: string; search?: Record<string, string>; value: number; label: string; note?: string }) {
  return (
    <Link to={to} search={search} className="py-2.5 hover:bg-ground border-l border-line first:border-l-0">
      <div className="text-[20px] font-semibold tabular-nums leading-tight">{value}</div>
      <div className="text-[12px] text-muted">{label}</div>
      {note && <div className="text-[11px] text-amber">{note}</div>}
    </Link>
  );
}
