import type { Cockpit } from "@cockpit/shared";

// `tailscale serve` proxies to cockpit from this machine and adds the signed-in user's login as a header,
// for devices that belong to a user. Only that header from a local proxy counts, never one from outside.
export default function setup(k: Cockpit) {
  k.access({
    name: "Tailscale",
    allow: (req) => {
      const login = k.setting<string>("login");
      return !!login && req.local && !!req.header("x-forwarded-for") && req.header("tailscale-user-login") === login;
    },
  });

  // the tailnet's machines, for adding one as a node from the Machines screen
  k.route("GET", "/peers", async () => {
    const st = JSON.parse(await k.run("tailscale", ["status", "--json"])) as { Self?: Peer; Peer?: Record<string, Peer> };
    const view = (p: Peer, self = false) => ({ name: p.HostName, dns: (p.DNSName ?? "").replace(/\.$/, ""), ip: p.TailscaleIPs?.[0] ?? "", os: p.OS ?? "", online: self || !!p.Online, self });
    return [...(st.Self ? [view(st.Self, true)] : []), ...Object.values(st.Peer ?? {}).map((p) => view(p))];
  });
  k.screen({ id: "machines", title: "Machines", page: "assets/machines.html" });
}

interface Peer {
  HostName: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
}
