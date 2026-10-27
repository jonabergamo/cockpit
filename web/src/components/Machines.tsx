import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Machine } from "@cockpit/shared";
import { useState } from "react";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useLive } from "../lib/live";
import { Button, ErrorNote, inputClass, Tag } from "./ui";

interface MachinesRes {
  hub: string;
  role: "all" | "hub" | "node";
  machines: Machine[];
}

const LOOK: Record<
  Machine["state"],
  { tone: "green" | "amber" | "red" | "faint"; label: string }
> = {
  up: { tone: "green", label: "connected" },
  connecting: { tone: "amber", label: "connecting" },
  down: { tone: "red", label: "disconnected" },
  refused: { tone: "red", label: "refused" },
};

interface Placement {
  id: string;
  label: string;
  help: string;
  value: string;
  runs: string;
  why: string;
  options: string[];
}

// Each kind of work and the machine it runs on: auto picks (and says why), or pin it to one
export function PlacementSection({ machines }: { machines: Machine[] }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["placement"],
    queryFn: () => api.get<Placement[]>("/machines/placement"),
  });
  const set = useMutation({
    mutationFn: (b: { cap: string; value: string }) =>
      api.put<Placement[]>("/machines/placement", b),
    onSuccess: (d) => qc.setQueryData(["placement"], d),
  });
  const name = (id: string) =>
    id === "here"
      ? "this machine"
      : (machines.find((m) => m.id === id)?.name ?? id);
  if (!q.data) return <ErrorNote error={q.error} />;
  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div>
        <h2 className="font-semibold">Where things run</h2>
        <p className="text-[13px] text-muted mt-0.5">
          Auto picks for you: automations go to a node so they keep going while
          this machine sleeps, transcription goes where there's a GPU, and the
          rest stays here.
        </p>
      </div>
      <div className="divide-y divide-line border border-line rounded-md">
        {q.data.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center gap-3 px-3 py-2 text-[13px]"
          >
            <div className="flex-1 min-w-[240px]">
              <div className="font-medium">{p.label}</div>
              <div className="text-[12px] text-muted">{p.help}</div>
            </div>
            <div className="w-56 space-y-0.5">
              <select
                value={p.value}
                onChange={(e) =>
                  set.mutate({ cap: p.id, value: e.target.value })
                }
                disabled={set.isPending}
                className={`${inputClass} w-full`}
                aria-label={`Where ${p.label.toLowerCase()} run`}
              >
                <option value="auto">Auto ({name(p.runs)})</option>
                <option value="here">This machine</option>
                {p.options.map((id) => (
                  <option key={id} value={id}>
                    {name(id)}
                  </option>
                ))}
              </select>
              <div className="text-[11px] text-faint truncate" title={p.why}>
                {p.why}
              </div>
            </div>
          </div>
        ))}
      </div>
      <ErrorNote error={set.error} />
    </section>
  );
}

interface PluginPlace {
  id: string;
  name: string;
  bundled: boolean;
  value: string;
  machine?: string;
}

// Each plugin that's on, and the machine it runs on: one put on a node runs only there, and this hub shows its
// screens and passes its requests on. For plugins that work with that machine's tools, like Docker.
export function PluginPlacement({ machines }: { machines: Machine[] }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["plugin-placement"],
    queryFn: () => api.get<PluginPlace[]>("/machines/plugins"),
  });
  const set = useMutation({
    mutationFn: (b: { id: string; value: string }) =>
      api.put("/machines/plugins", b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plugin-placement"] }),
  });
  if (!q.data?.length) return <ErrorNote error={q.error} />;
  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div>
        <h2 className="font-semibold">Where plugins run</h2>
        <p className="text-[13px] text-muted mt-0.5">
          A plugin put on another machine runs only there, with that machine's
          tools (its Docker, its CLIs). Its screens still show here.
        </p>
      </div>
      <div className="divide-y divide-line border border-line rounded-md">
        {q.data.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center gap-3 px-3 py-2 text-[13px]"
          >
            <div className="flex-1 min-w-[200px]">
              <span className="font-medium">{p.name}</span>{" "}
              {p.bundled && (
                <span className="text-[12px] text-faint">bundled</span>
              )}
            </div>
            <select
              value={p.value}
              onChange={(e) => set.mutate({ id: p.id, value: e.target.value })}
              disabled={set.isPending}
              className={`${inputClass} w-56`}
              aria-label={`Where ${p.name} runs`}
            >
              <option value="here">This machine</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <ErrorNote error={set.error} />
    </section>
  );
}

// The nodes this hub works with: add one, pair it with the command shown, and see whether each can be reached
export function MachinesSection() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["machines"],
    queryFn: () => api.get<MachinesRes>("/machines"),
  });
  useLive(
    (ev) =>
      ev.type === "machines" &&
      qc.setQueryData<MachinesRes>(
        ["machines"],
        (d) => d && { ...d, machines: ev.machines },
      ),
    [qc],
  );
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [pairing, setPairing] = useState<{ id: string; command: string }>();
  const add = useMutation({
    mutationFn: () =>
      api.post<{ machine: Machine; pair: string }>("/machines", {
        name,
        address,
      }),
    onSuccess: (r) => {
      setPairing({ id: r.machine.id, command: r.pair });
      setName("");
      setAddress("");
      qc.invalidateQueries({ queryKey: ["machines"] });
    },
  });
  const show = useMutation({
    mutationFn: (id: string) =>
      api
        .get<{ command: string }>(`/machines/${id}/pair`)
        .then((r) => ({ id, command: r.command })),
    onSuccess: setPairing,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/machines/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["machines"] }),
  });
  const retry = (id: string) => api.post(`/machines/${id}/retry`);
  const d = q.data;

  return (
    <div className="space-y-4">
      <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
        <div>
          <h2 className="font-semibold">Machines</h2>
          <p className="text-[13px] text-muted mt-0.5">
            Other machines this cockpit works with. A node keeps the terminals,
            agent sessions, the repo and the automations on its machine, and
            keeps them going while this one sleeps. Run{" "}
            <code className="text-[12px]">cockpit node</code> on it, add it here
            with its address, then run the pairing command it gives you on the
            node.
          </p>
          {d && d.role === "all" && !!d.machines.length && (
            <p className="text-[12px] text-faint mt-1">
              This cockpit runs everything itself (role all). Set role =
              &quot;hub&quot; in config.local.toml to leave the work to the
              nodes.
            </p>
          )}
        </div>
        <ErrorNote error={q.error} />
        {!!d?.machines.length && (
          <div className="divide-y divide-line border border-line rounded-md">
            {d.machines.map((m) => (
              <div
                key={m.id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]"
              >
                <div className="flex-1 min-w-[200px]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{m.name}</span>
                    <Tag tone={LOOK[m.state].tone}>{LOOK[m.state].label}</Tag>
                    {m.state === "up" && m.rtt !== undefined && (
                      <span className="text-[12px] text-faint">{m.rtt} ms</span>
                    )}
                  </div>
                  <div
                    className="text-[12px] text-muted truncate"
                    title={m.url}
                  >
                    {m.url} ·{" "}
                    {m.state === "up"
                      ? `since ${ago(m.since)}`
                      : `${m.state === "connecting" ? "trying" : "down"} since ${ago(m.since)}`}
                    {m.info
                      ? ` · ${m.info.hostname}, ${m.info.platform}${m.info.gpu ? ", GPU" : ""}, ${m.info.terminals} terminals`
                      : ""}
                  </div>
                  {m.error && m.state !== "up" && (
                    <div className="text-[12px] text-red">{m.error}</div>
                  )}
                </div>
                {m.state !== "up" && (
                  <Button size="sm" variant="ghost" onClick={() => retry(m.id)}>
                    Try now
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => show.mutate(m.id)}
                >
                  Pairing command
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    confirm(
                      `Stop working with ${m.name}? Its terminals and sessions stay on it.`,
                    ) && remove.mutate(m.id)
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
        {pairing && (
          <div className="border border-amber/50 bg-amber-soft/30 rounded-md p-3 space-y-1.5 text-[13px]">
            <div>
              Run this on the node to pair it with this hub. Keep it to
              yourself, it's the node's key to this hub.
            </div>
            <pre className="rounded-md bg-ground px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-all">
              {pairing.command}
            </pre>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => navigator.clipboard?.writeText(pairing.command)}
              >
                Copy
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPairing(undefined)}
              >
                Done
              </Button>
            </div>
          </div>
        )}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name, like devbox"
            className={`${inputClass} w-40`}
          />
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Address: devbox, devbox.tailnet.ts.net or 100.x.y.z:8771"
            className={`${inputClass} flex-1 min-w-[220px]`}
          />
          <Button
            variant="primary"
            disabled={!name.trim() || !address.trim() || add.isPending}
          >
            {add.isPending ? "Adding" : "Add machine"}
          </Button>
        </form>
        <ErrorNote error={add.error ?? remove.error ?? show.error} />
      </section>
      {!!d?.machines.length && <PlacementSection machines={d.machines} />}
      {!!d?.machines.length && d.role === "hub" && (
        <PluginPlacement machines={d.machines} />
      )}
    </div>
  );
}
