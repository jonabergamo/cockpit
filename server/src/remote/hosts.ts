// The machines this cockpit knows. For now that's only this one; nodes join here once they can be paired.
import type { Host } from "./host.ts";
import { localHost } from "./local.ts";

const hosts = new Map<string, Host>([[localHost.id, localHost]]);

export const listHosts = () => [...hosts.values()];
export const getHost = (id: string) => hosts.get(id);

// The machine something lives on: a terminal or a run by its node, else this one
export function hostFor(ctx: { node?: string } = {}): Host {
  if (!ctx.node || ctx.node === localHost.id) return localHost;
  const h = hosts.get(ctx.node);
  if (!h) throw Object.assign(new Error(`No machine called ${ctx.node} is connected`), { status: 503 });
  return h;
}
