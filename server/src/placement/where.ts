// Where each kind of work runs, once there's more than one machine. Settings → Machines sets each one to "auto",
// "here" (this machine) or a machine by its id; auto picks by what each machine is good for. The answer is a
// machine's id, or undefined for this one.
import type { Machine } from "@cockpit/shared";
import { config } from "../config.ts";
import { getSettings } from "../settings.ts";
import { run } from "../util.ts";

export type Cap = "automations" | "headless" | "whisper";

export interface CapView {
  id: Cap;
  label: string;
  help: string;
  value: string;
  // where it runs now: a machine's id, or "here"
  runs: string;
  why: string;
  // the machines it can be put on
  options: string[];
}

const CAPS: { id: Cap; label: string; help: string }[] = [
  { id: "automations", label: "Automations", help: "Tasks, the overnight queue, autopilot, checks after a session, stacked work and CI comparisons. They keep going while this machine sleeps when they're on another." },
  { id: "headless", label: "Claude without a terminal", help: "Asking cockpit a question, sprint notes and other one-off claude -p runs." },
  { id: "whisper", label: "Transcription", help: "Whisper for meetings. Much faster on a machine with an NVIDIA GPU." },
];

// whether this machine has an NVIDIA GPU, found once at start
let gpu = false;
export const gpuProbed = run("nvidia-smi", ["-L"], { timeout: 5000 }).then(
  (out) => void (gpu = /GPU \d/.test(out)),
  () => {},
);
export const hasGpu = () => gpu;

let machines: () => Machine[] = () => [];
export const useMachines = (fn: () => Machine[]) => void (machines = fn);

const up = (m: Machine) => m.state === "up";

// what auto means for each: automations go to the first node when this one is a hub, so they run while it
// sleeps; Whisper goes where the GPU is; the rest stays here
function auto(cap: Cap, list: Machine[]): { machine?: string; why: string } {
  if (cap === "automations") {
    if (config.role !== "hub") return { why: "this machine runs everything (role all)" };
    const first = list[0];
    return first ? { machine: first.id, why: `${first.name} is the first machine added` } : { why: "no machine added yet" };
  }
  if (cap === "whisper" && !gpu) {
    const g = list.find((m) => up(m) && m.info?.gpu);
    if (g) return { machine: g.id, why: `${g.name} has a GPU` };
  }
  return { why: cap === "whisper" && gpu ? "this machine has a GPU" : "this machine" };
}

export function resolve(cap: Cap, value = getSettings().machines.placement[cap], list = machines()): { machine?: string; why: string } {
  if (value === "here") return { why: "set to this machine" };
  if (value && value !== "auto") {
    const m = list.find((x) => x.id === value);
    if (!m) return { ...auto(cap, list), why: `${value} isn't a machine any more, so auto` };
    // automations can only move off a hub; a single machine (role all) runs them itself
    if (cap === "automations" && config.role !== "hub") return { why: "role all runs them here; set role = \"hub\" to move them" };
    // one-off work doesn't wait for a machine that's away; automations stay where they are, since they keep going there
    if (cap !== "automations" && !up(m)) return { why: `set to ${m.name}, which isn't connected, so here` };
    return { machine: m.id, why: `set to ${m.name}` };
  }
  return auto(cap, list);
}

export const where = (cap: Cap) => resolve(cap).machine;

export function placementView(): CapView[] {
  const list = machines();
  const set = getSettings().machines.placement;
  return CAPS.map((c) => {
    const r = resolve(c.id, set[c.id], list);
    const options = c.id === "automations" && config.role !== "hub" ? [] : list.map((m) => m.id);
    return { ...c, value: set[c.id], runs: r.machine ?? "here", why: r.why, options };
  });
}

// the node a plugin runs on, when it's put on one; only a hub hands plugins out
export function pluginOn(id: string, list = machines()): string | undefined {
  if (config.role !== "hub") return;
  const value = getSettings().machines.plugins[id];
  return value && value !== "here" && list.some((m) => m.id === value) ? value : undefined;
}
