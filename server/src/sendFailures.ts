// Failed runs sent to the agent by themselves, when that's switched on in Settings: a run you or a script started
// (a terminal, `cockpit run`, verify, a plugin) fails, and the Claude session working there gets what failed and the
// end of its output, asked to fix it. What the agent ran itself it already saw, and a PR's CI checks have their own
// "Fix checks", so those aren't sent. Each run goes once. It runs on the hub, which hears every machine's runs.
import type { Run } from "@cockpit/shared";
import { tap } from "./hub.ts";
import { requestApi } from "./remote/forward.ts";
import { getRun, settledFail } from "./runs.ts";
import { getSettings } from "./settings.ts";
import { sendRunFailure } from "./verify.ts";

const AGENT_RAN = new Set(["hook", "mcp"]);
// a failure heard about after the fact (a node catching up, a reconnect) isn't news to send
const FRESH_MS = 2 * 60_000;
const sent = new Set<string>();

export function shouldSend(r: Run, now = Date.now()) {
  return r.status === "fail" && !settledFail(r) && !r.meta.quiet && !AGENT_RAN.has(r.source) && r.kind !== "ci" && (r.endedAt ?? 0) > now - FRESH_MS && !sent.has(r.id);
}

async function send(r: Run) {
  sent.add(r.id);
  if (sent.size > 2000) sent.delete(sent.values().next().value!);
  if (!r.node || r.node === "local" || getRun(r.id)) return sendRunFailure(r.id);
  const res = await requestApi(r.node, { method: "POST", path: `/runs/${encodeURIComponent(r.id)}/send`, headers: { "content-type": "application/json" }, body: "{}" });
  if (res.status >= 300) throw new Error(res.body);
}

export function startSendingFailures() {
  tap((ev) => {
    if (ev.type !== "run" || !getSettings().runs.sendFailures || !shouldSend(ev.run)) return;
    // no session to send it to is fine: there's nobody working there to fix it
    void send(ev.run).catch(() => {});
  });
}
