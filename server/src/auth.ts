import type { IncomingHttpHeaders } from "node:http";
import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { accessProviders } from "./plugins.ts";

const loopback = (addr?: string) => !!addr && (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1");

// A direct request from this machine is always fine. Anything else, from another machine or through a proxy
// (which sets X-Forwarded-For), needs an access plugin to let it in. With none on, cockpit is local only.
export function allowed(headers: IncomingHttpHeaders | Headers, remote?: string) {
  const header = (k: string) => (headers instanceof Headers ? headers.get(k) : (headers[k.toLowerCase()] as string | undefined)) ?? undefined;

  const origin = header("origin");
  if (origin && new URL(origin).host !== header("host")) return false;

  const local = loopback(remote);
  if (local && !header("x-forwarded-for")) return true;
  return accessProviders().some((a) => {
    try {
      return a.allow({ header, remote, local }) === true;
    } catch {
      return false;
    }
  });
}

export const auth: MiddlewareHandler = async (c, next) => {
  const remote = getConnInfo(c).remote.address;
  if (!allowed(c.req.raw.headers, remote)) return c.text("unauthorized", 401);
  await next();
};
