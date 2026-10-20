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
}
