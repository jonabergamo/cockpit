import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Gear, GearAction } from "@cockpit/shared";
import { useState } from "react";
import { api } from "../lib/api";
import { ago, bytes } from "../lib/format";
import { Button, ErrorNote, inputClass, Tag } from "./ui";

// A bar for a share of something, amber past 80% and red past 90%
export function Bar({ label, share, text, title }: { label: string; share?: number; text: string; title?: string }) {
  const pct = share === undefined ? 0 : Math.min(100, Math.max(0, Math.round(share * 100)));
  const tone = pct >= 90 ? "bg-red" : pct >= 80 ? "bg-amber" : "bg-cobalt";
  return (
    <div className="min-w-0" title={title}>
      <div className="flex items-baseline gap-1 text-[12px]">
        <span className="text-muted">{label}</span>
        <span className={`ml-auto truncate tabular-nums ${pct >= 90 ? "text-red" : pct >= 80 ? "text-amber" : "text-faint"}`}>{text}</span>
      </div>
      <div className="h-1.5 rounded-full bg-line mt-1 overflow-hidden" role="meter" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        {share !== undefined && <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />}
      </div>
    </div>
  );
}

type GearRes = Gear & { runs?: Gear["runs"] };

export function useGear(id: string, enabled: boolean) {
  return useQuery({ queryKey: ["gear", id], queryFn: () => api.get<GearRes>(`/machines/${id}/gear`), refetchInterval: 15_000, enabled });
}

const hasDevices = (g?: Gear) => !!(g?.sims?.length || g?.avds?.length || g?.phones?.length);
const hasModels = (g?: Gear) => !!(g?.gpu || g?.ollama || g?.whisper);

// The extra cards for one machine: its simulators and devices, and its GPU and local models, each only when it has them
export function GearCards({ id, name, up }: { id: string; name: string; up: boolean }) {
  const q = useGear(id, up);
  const g = q.data;
  return (
    <>
      {hasDevices(g) && <DevicesCard id={id} name={name} gear={g!} />}
      {hasModels(g) && <ModelsCard name={name} gear={g!} />}
    </>
  );
}

function Card({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="bg-panel border border-line rounded-lg flex flex-col">
      <header className="px-4 pt-3 pb-2 flex items-baseline gap-2">
        <h2 className="font-semibold text-[15px] truncate flex-1">{title}</h2>
        <span className="text-[12px] text-faint">{sub}</span>
      </header>
      <div className="divide-y divide-line border-t border-line">{children}</div>
    </section>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="px-4 py-2.5 space-y-1.5">
    <div className="text-[11px] uppercase tracking-wide text-faint">{title}</div>
    {children}
  </div>
);

const Dot = ({ on, busy }: { on: boolean; busy?: boolean }) => <span className={`size-2 rounded-full shrink-0 ${on ? "bg-green" : "bg-line"} ${busy ? "animate-pulse" : ""}`} />;

function DevicesCard({ id, name, gear }: { id: string; name: string; gear: Gear }) {
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (a: GearAction) => api.post<Gear>(`/machines/${id}/gear`, a),
    onSuccess: (g) => qc.setQueryData(["gear", id], (old: GearRes | undefined) => ({ ...g, runs: old?.runs })),
  });
  const busy = (match: (a: GearAction) => boolean) => act.isPending && !!act.variables && match(act.variables);
  const [boot, setBoot] = useState("");
  const [install, setInstall] = useState<{ key: string; path: string }>();

  const booted = gear.sims?.filter((s) => s.booted) ?? [];
  const off = gear.sims?.filter((s) => !s.booted) ?? [];
  const pick = boot || off[0]?.udid || "";

  // a path on that machine to a .app (simulator) or .apk (Android), typed in place
  const installRow = (key: string, a: (path: string) => GearAction, what: string) =>
    install?.key === key ? (
      <form
        className="flex gap-2 pl-4"
        onSubmit={(e) => {
          e.preventDefault();
          act.mutate(a(install.path), { onSuccess: () => setInstall(undefined) });
        }}
      >
        <input autoFocus value={install.path} onChange={(e) => setInstall({ key, path: e.target.value })} placeholder={`Path to the ${what} on ${name}`} className={`${inputClass} flex-1 min-w-0 h-7 text-[12px]`} />
        <Button size="sm" variant="primary" disabled={!install.path.trim() || act.isPending}>
          {act.isPending ? "Installing" : "Install"}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setInstall(undefined)}>
          Cancel
        </Button>
      </form>
    ) : null;

  return (
    <Card title="Simulators and devices" sub={name}>
      {!!gear.sims?.length && (
        <Section title="iOS simulators">
          {booted.map((s) => (
            <div key={s.udid} className="space-y-1.5">
              <div className="flex items-center gap-2 text-[13px]">
                <Dot on />
                <span className="font-medium truncate">{s.name}</span>
                <span className="text-[12px] text-faint truncate flex-1">{s.runtime}</span>
                <Button size="sm" variant="ghost" onClick={() => setInstall({ key: s.udid, path: "" })}>
                  Install .app
                </Button>
                <Button size="sm" variant="ghost" disabled={busy((a) => a.do === "sim.shutdown" && a.udid === s.udid)} onClick={() => act.mutate({ do: "sim.shutdown", udid: s.udid })}>
                  {busy((a) => a.do === "sim.shutdown" && a.udid === s.udid) ? "Shutting down" : "Shut down"}
                </Button>
              </div>
              {installRow(s.udid, (path) => ({ do: "sim.install", udid: s.udid, path }), ".app build")}
            </div>
          ))}
          {!booted.length && <div className="text-[12px] text-faint">None running.</div>}
          {!!off.length && (
            <div className="flex gap-2 pt-0.5">
              <select value={pick} onChange={(e) => setBoot(e.target.value)} className={`${inputClass} flex-1 min-w-0 h-7 text-[12px]`} aria-label="Simulator to boot">
                {off.map((s) => (
                  <option key={s.udid} value={s.udid}>
                    {s.name} · {s.runtime}
                  </option>
                ))}
              </select>
              <Button size="sm" disabled={!pick || busy((a) => a.do === "sim.boot")} onClick={() => act.mutate({ do: "sim.boot", udid: pick })}>
                {busy((a) => a.do === "sim.boot") ? "Booting" : "Boot"}
              </Button>
            </div>
          )}
        </Section>
      )}
      {!!gear.avds?.length && (
        <Section title="Android emulators">
          {gear.avds.map((a) => (
            <div key={a.name} className="space-y-1.5">
              <div className="flex items-center gap-2 text-[13px]">
                <Dot on={!!a.serial} busy={busy((x) => x.do === "avd.start" && x.name === a.name)} />
                <span className="font-medium truncate flex-1">{a.name.replace(/_/g, " ")}</span>
                {a.serial ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setInstall({ key: a.serial!, path: "" })}>
                      Install .apk
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy((x) => x.do === "avd.stop" && x.serial === a.serial)} onClick={() => act.mutate({ do: "avd.stop", serial: a.serial! })}>
                      Stop
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy((x) => x.do === "avd.start" && x.name === a.name)} onClick={() => act.mutate({ do: "avd.start", name: a.name })} title="It takes a little while to boot, then shows up as running">
                    Start
                  </Button>
                )}
              </div>
              {a.serial && installRow(a.serial, (path) => ({ do: "apk.install", serial: a.serial!, path }), ".apk")}
            </div>
          ))}
        </Section>
      )}
      {!!gear.phones?.length && (
        <Section title="Phones">
          {gear.phones.map((p) => (
            <div key={p.id} className="space-y-1.5">
              <div className="flex items-center gap-2 text-[13px]">
                <Dot on={p.connected} />
                <span className="font-medium truncate">{p.name}</span>
                <span className="text-[12px] text-faint flex-1">{p.kind === "ios" ? "iPhone" : "Android"} · {p.connected ? "connected" : "not connected"}</span>
                {p.kind === "android" && p.connected && (
                  <Button size="sm" variant="ghost" onClick={() => setInstall({ key: p.id, path: "" })}>
                    Install .apk
                  </Button>
                )}
              </div>
              {p.kind === "android" && installRow(p.id, (path) => ({ do: "apk.install", serial: p.id, path }), ".apk")}
            </div>
          ))}
        </Section>
      )}
      {act.error && (
        <div className="px-4 py-2">
          <ErrorNote error={act.error} />
        </div>
      )}
    </Card>
  );
}

const ms = (n?: number) => (n === undefined ? "" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

function ModelsCard({ name, gear }: { name: string; gear: GearRes }) {
  const { gpu, ollama, whisper } = gear;
  const runs = new Set(gear.runs ?? []);
  const LABEL = { ollama: "Ollama", whisper: "Whisper" } as const;
  return (
    <Card title={gpu ? "GPU and local models" : "Local models"} sub={name}>
      {gpu && (
        <Section title={gpu.name}>
          <div className="grid grid-cols-2 gap-3">
            <Bar label="Use" share={gpu.util / 100} text={`${gpu.util}%${gpu.temp !== undefined ? ` · ${gpu.temp}°C` : ""}`} />
            <Bar label="Memory" share={gpu.memUsed / gpu.memTotal} text={`${bytes(gpu.memUsed)} of ${bytes(gpu.memTotal)}`} />
          </div>
          {gpu.apps.map((a) => (
            <div key={a.pid} className="flex items-center gap-2 text-[12px]">
              <span className="font-medium">{a.what ? LABEL[a.what] : a.name}</span>
              {a.what && <span className="text-faint truncate">{a.name}</span>}
              <span className="ml-auto text-muted tabular-nums">{bytes(a.mem)}</span>
            </div>
          ))}
          {!gpu.apps.length && <div className="text-[12px] text-faint">Nothing is using it.</div>}
        </Section>
      )}
      {ollama && (
        <Section title="Ollama">
          {!ollama.up && <div className="text-[12px] text-red">Not answering at {ollama.url}</div>}
          {ollama.up && !ollama.loaded.length && <div className="text-[12px] text-faint">Running, no model in memory.</div>}
          {ollama.loaded.map((m) => (
            <div key={m.name} className="flex items-center gap-2 text-[13px]">
              <Dot on />
              <span className="font-medium truncate">{m.name}</span>
              <span className="text-[12px] text-faint truncate flex-1">
                {bytes(m.size)}
                {m.size ? `, ${Math.round((100 * m.vram) / m.size)}% on the GPU` : ""}
              </span>
              {m.until && untilText(m.until) && <span className="text-[12px] text-faint shrink-0" title="Ollama unloads it after a while without use">unloads {untilText(m.until)}</span>}
            </div>
          ))}
          {ollama.quick && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] pt-0.5">
              <span className="text-muted">Quick answers</span>
              <span className="font-medium">{ollama.quick.model}</span>
              {runs.has("quick") && <Tag tone="cobalt">go here</Tag>}
              {!ollama.quick.loaded && ollama.up && <span className="text-faint">not loaded, the next one waits for it</span>}
              <span className="ml-auto text-faint tabular-nums">
                {ollama.quick.lastMs !== undefined ? `last ${ms(ollama.quick.lastMs)}, usually ${ms(ollama.quick.avgMs)}` : runs.has("quick") ? "none asked since cockpit started" : ""}
                {ollama.quick.at ? ` · ${ago(ollama.quick.at)}` : ""}
              </span>
              {!!ollama.quick.failed && <span className="text-red w-full">{ollama.quick.failed} failed since cockpit started</span>}
            </div>
          )}
        </Section>
      )}
      {whisper && (
        <Section title="Whisper">
          <div className="flex items-center gap-2 text-[13px]">
            <Dot on={whisper.running} busy={whisper.running} />
            <span className="flex-1">{whisper.running ? "Transcribing now" : whisper.installed ? "Installed, idle" : "Not installed"}</span>
            {runs.has("whisper") && <Tag tone="cobalt">transcription goes here</Tag>}
          </div>
        </Section>
      )}
    </Card>
  );
}

function untilText(iso: string) {
  const left = Date.parse(iso) - Date.now();
  if (!(left > 0)) return "soon";
  const min = Math.round(left / 60_000);
  // kept loaded for good (keep_alive -1 sets a date centuries away): nothing to say
  if (min > 24 * 60) return undefined;
  return min < 60 ? `in ${min} min` : `in ${Math.round(min / 60)} h`;
}
