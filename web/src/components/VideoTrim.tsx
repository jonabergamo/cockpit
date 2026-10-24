import { useQueryClient } from "@tanstack/react-query";
import type { RunArtifact } from "@cockpit/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { Button, ErrorNote } from "./ui";

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

// A run's video, with a way to cut the dead time off its start and end. Cutting always works from the whole
// recording, which the server keeps, so a cut can be changed or undone later.
export function RunVideo({ runId, a, url }: { runId: string; a: RunArtifact; url: string }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLVideoElement>(null);
  const [editing, setEditing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [busy, setBusy] = useState<"cut" | "restore">();
  const [err, setErr] = useState<unknown>();
  // a new cut is a new file at the same address, so the address changes with it
  const v = a.trimmed ? `v=${a.trimmed.at}` : "";
  const src = editing && a.trimmed ? `${url}?original=1` : `${url}${v ? `?${v}` : ""}`;

  useEffect(() => {
    if (!editing) return;
    setStart(a.trimmed?.start ?? 0);
    setEnd(a.trimmed?.end ?? 0);
  }, [editing, a.trimmed]);

  const loaded = () => {
    const d = ref.current?.duration ?? 0;
    if (!Number.isFinite(d)) return;
    setDuration(d);
    if (editing && !a.trimmed) setEnd((e) => e || d);
  };

  // plays the kept part once, stopping at its end
  const preview = () => {
    const el = ref.current;
    if (!el) return;
    el.currentTime = start;
    void el.play();
    const stop = () => {
      if (el.currentTime >= end) {
        el.pause();
        el.removeEventListener("timeupdate", stop);
      }
    };
    el.addEventListener("timeupdate", stop);
  };
  const seek = (t: number) => ref.current && (ref.current.currentTime = t);
  const now = () => ref.current?.currentTime ?? 0;

  const act = async (what: "cut" | "restore") => {
    setBusy(what);
    setErr(undefined);
    try {
      const path = `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(a.name)}/${what === "cut" ? "trim" : "restore"}`;
      await (what === "cut" ? api.post(path, { start, end }) : api.post(path));
      await qc.invalidateQueries({ queryKey: ["run", runId] });
      setEditing(false);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(undefined);
    }
  };

  const valid = end - start >= 0.5;
  const pct = (t: number) => (duration ? `${(t / duration) * 100}%` : "0%");

  return (
    <div className="space-y-1.5">
      <video ref={ref} key={src} src={src} controls preload="metadata" onLoadedMetadata={loaded} className="max-h-[70vh] max-w-full rounded-lg border border-line bg-black" />
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <a href={`${url}${v ? `?${v}` : ""}`} download={a.name} className="text-muted hover:text-ink">
          {a.name}
        </a>
        {a.trimmed && !editing && <span className="text-faint">· cut to {clock(a.trimmed.start)} to {clock(a.trimmed.end)} of the recording</span>}
        {!editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} title="Cut the dead time off its start and end">
            {a.trimmed ? "Change the cut" : "Cut start and end"}
          </Button>
        )}
      </div>
      {editing && (
        <div className="bg-panel border border-line rounded-lg p-3 space-y-2.5 text-[13px] max-w-[720px]">
          <p className="text-muted">Play or scrub the video to where it really starts and ends, then set each one there. Or drag the sliders.</p>
          <div className="relative h-2 rounded bg-ground">
            <div className="absolute inset-y-0 rounded bg-cobalt" style={{ left: pct(start), width: duration ? `${((end - start) / duration) * 100}%` : "0%" }} />
          </div>
          {(["start", "end"] as const).map((k) => {
            const value = k === "start" ? start : end;
            const set = k === "start" ? setStart : setEnd;
            return (
              <div key={k} className="flex flex-wrap items-center gap-2">
                <span className="w-10 text-muted capitalize">{k}</span>
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.1}
                  value={value}
                  onChange={(e) => {
                    const t = Number(e.target.value);
                    set(t);
                    seek(t);
                  }}
                  className="flex-1 min-w-[160px] accent-[var(--cobalt)]"
                  aria-label={`Where it ${k}s`}
                />
                <span className="w-16 tabular-nums text-right">{clock(value)}</span>
                <Button size="sm" onClick={() => set(Math.min(now(), duration || now()))} title="The video's current time">
                  Set to now
                </Button>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-faint flex-1">{valid ? `Keeps ${clock(end - start)} of ${clock(duration)}` : "The end has to come after the start"}</span>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            {a.trimmed && (
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("restore")}>
                {busy === "restore" ? "Putting it back" : "Put the whole recording back"}
              </Button>
            )}
            <Button size="sm" disabled={!valid} onClick={preview}>
              Play the cut
            </Button>
            <Button size="sm" variant="primary" disabled={!valid || !!busy} onClick={() => act("cut")}>
              {busy === "cut" ? "Cutting" : "Cut it"}
            </Button>
          </div>
          <ErrorNote error={err} />
        </div>
      )}
    </div>
  );
}
