import type { Run } from "@cockpit/shared";

// Where a running run's screen can be watched: the virtual screen cockpit records on (its live.jpg), or what a plugin
// says in meta.liveUrl (a simulator on another machine, say). Only a path on cockpit itself.
export function liveSrc(r: Pick<Run, "id" | "status" | "meta">) {
  if (r.status !== "running") return undefined;
  if (r.meta.live === true) return `/api/runs/${encodeURIComponent(r.id)}/live.jpg`;
  const u = r.meta.liveUrl;
  return typeof u === "string" && /^\/api\/[\w./%-]+$/.test(u) ? u : undefined;
}

// recording a video of it, not only showing it
export const recording = (r: Pick<Run, "meta">) => r.meta.live === true || r.meta.video === true;
