// The plugins a hub has put on a node: their screens and sidebar badges come from that node, where they run
import type { Badge, ScreenInfo } from "@cockpit/shared";
import { setPluginBadge } from "../badges.ts";
import { adoptRemotePlugins } from "../plugins.ts";
import type { RemoteLink } from "./link.ts";

type Info = { id: string; screens: ScreenInfo[]; badges: Record<string, Badge> };

export function addPluginLink(machine: string, link: RemoteLink) {
  const fetch = async () => {
    const list = await link.request<Info[]>("plugins.info").catch(() => undefined);
    if (!list) return;
    adoptRemotePlugins(machine, list);
    for (const p of list) for (const [screen, b] of Object.entries(p.badges)) setPluginBadge(p.id, screen, b);
  };
  link.onUp((c) => {
    c.on("plugins.changed", () => void fetch());
    c.on("plugin.badges", ({ plugin, badges }: { plugin: string; badges: Record<string, Badge> }) => {
      for (const [screen, b] of Object.entries(badges)) setPluginBadge(plugin, screen, b);
    });
    void fetch();
  });
}
