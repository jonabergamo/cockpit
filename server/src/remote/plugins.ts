// The plugins a hub has put on a node: their screens and sidebar badges come from that node, where they run
import type { Badge, ScreenInfo } from "@cockpit/shared";
import { replacePluginBadges } from "../badges.ts";
import { pluginOn } from "../placement/where.ts";
import { adoptRemotePlugins } from "../plugins.ts";
import type { RemoteLink } from "./link.ts";

type Info = { id: string; screens: ScreenInfo[]; badges: Record<string, Badge> };

const fetchers = new Map<string, () => Promise<void>>();
// asked again when a plugin is put on that node, so its screens and badges show without waiting for a reconnect
export const refreshPlugins = (machine: string) => fetchers.get(machine)?.();

export function addPluginLink(machine: string, link: RemoteLink) {
  // only the ones put on this node: the others run here too, and their badges are this machine's to set
  const mine = (id: string) => pluginOn(id) === machine;
  const fetch = async () => {
    const list = await link.request<Info[]>("plugins.info").catch(() => undefined);
    if (!list) return;
    adoptRemotePlugins(machine, list);
    for (const p of list) if (mine(p.id)) replacePluginBadges(p.id, p.badges);
  };
  fetchers.set(machine, fetch);
  link.onUp((c) => {
    c.on("plugins.changed", () => void fetch());
    c.on("plugin.badges", ({ plugin, badges }: { plugin: string; badges: Record<string, Badge> }) => mine(plugin) && replacePluginBadges(plugin, badges));
    void fetch();
  });
}
