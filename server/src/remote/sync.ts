// The hub's settings, passed on to its nodes: the ones the automations read (tasks, autopilot, budgets, kinds of
// work...) and the set up of the plugins they lean on. Sent whenever they change and whenever a link comes up,
// with a version, so a node that has it already does nothing, and one whose hub is away keeps using the last.
import { createHash } from "node:crypto";
import { adoptPluginSetup, placedOn, pluginSetupFor } from "../plugins.ts";
import { getSettings, onSettingsChanged, putSettings, readRow, writeRow } from "../settings.ts";
import type { RemoteLink } from "./link.ts";

export interface Synced {
  version: string;
  settings: ReturnType<typeof getSettings>;
  plugins: ReturnType<typeof pluginSetupFor>;
  // the plugins put on this node, which tell you things from there
  placed: string[];
}

// what one node gets: the same settings for all, the plugins as that node should run them
export function current(machine: string): Synced {
  const body = { settings: getSettings(), plugins: pluginSetupFor(machine), placed: placedOn(machine) };
  return { version: createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16), ...body };
}

const links = new Map<string, RemoteLink>();
let timer: NodeJS.Timeout | undefined;

const send = (machine: string, link: RemoteLink) => link.request("settings.sync", current(machine)).catch(() => {});

export function addSyncLink(machine: string, link: RemoteLink) {
  links.set(machine, link);
  link.onUp(() => void send(machine, link));
}

export const removeSyncLink = (machine: string) => void links.delete(machine);

// once the plugins have loaded, so the nodes get the set up of the ones they run
export const resendSettings = () => {
  for (const [machine, link] of links) if (link.status.state === "up") void send(machine, link);
};

// changes come in bursts (a form saves several rows), so they go out together a moment later
export function startSync() {
  onSettingsChanged(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const [machine, link] of links) if (link.status.state === "up") void send(machine, link);
    }, 1500);
    timer.unref?.();
  });
}

// a node's side
export const syncedVersion = () => readRow<string>("hubSettingsVersion");
export async function adopt(s: Synced) {
  if (s.version === syncedVersion()) return { version: s.version, changed: false };
  putSettings(s.settings);
  writeRow("placedHere", s.placed ?? []);
  await adoptPluginSetup(s.plugins);
  writeRow("hubSettingsVersion", s.version);
  return { version: s.version, changed: true };
}
