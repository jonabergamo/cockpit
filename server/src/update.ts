// Updating cockpit from its git remote: what's new upstream, and pulling, installing and building it, then a
// restart. Run as a service (launchd or systemd), cockpit restarts itself by exiting with a failure code, which
// both bring it back up from; run by hand, it says to restart it. On a hub, its nodes update first, since a hub and
// its nodes have to speak the same link protocol.
import { paths } from "./config.ts";
import { broadcast } from "./hub.ts";
import { startJob, type Job } from "./jobs.ts";
import { getSettings } from "./settings.ts";
import type { Change, UpdateStatus } from "@cockpit/shared";
import { run } from "./util.ts";

const git = (args: string[], timeout = 30_000) => run("git", args, { cwd: paths.root, timeout }).then((o) => o.trim());

// a conventional commit, "feat(work): the pipeline...", taken apart
export function parseCommit(line: string): Change | undefined {
  const [sha, at, subject, ...body] = line.split("\x1f");
  if (!sha || !subject) return undefined;
  const m = subject.match(/^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/);
  const detail = body.join("\x1f").trim().split(/\n\s*\n/)[0]?.replace(/\s*\n\s*/g, " ").trim();
  return { sha, at: Number(at) * 1000, type: m ? m[1].toLowerCase() : "other", scope: m?.[2] || undefined, subject: m ? m[3] : subject, detail: detail || undefined };
}

// The commits between two, oldest last, with merges left out
export async function changesBetween(from: string, to: string) {
  if (!/^[0-9a-f]{7,40}$/.test(from) || !/^[0-9a-f]{7,40}$|^@\{u\}$/.test(to)) throw Object.assign(new Error("not a commit"), { status: 400 });
  const out = await git(["log", "--no-merges", "--format=%H%x1f%ct%x1f%s%x1f%b%x1e", `${from}..${to}`]);
  return out
    .split("\x1e")
    .map((l) => parseCommit(l.trim()))
    .filter((c): c is Change => !!c);
}

export const runningAsService = () => !!(process.env.INVOCATION_ID || process.env.XPC_SERVICE_NAME?.startsWith("com.cockpit"));
export const currentCommit = () => git(["rev-parse", "HEAD"]).catch(() => "");

let last: UpdateStatus | undefined;
let checking: Promise<UpdateStatus> | undefined;

// What's new upstream. Fetches at most every 20 minutes unless forced.
export function updateStatus(force = false): Promise<UpdateStatus> {
  if (!force && last && Date.now() - last.checkedAt < 20 * 60_000) return Promise.resolve(last);
  checking ??= (async (): Promise<UpdateStatus> => {
    const current = await currentCommit();
    const base = { current, behind: 0, changes: [], service: runningAsService(), checkedAt: Date.now() };
    if (!current) return { ...base, blocked: "cockpit isn't a git checkout here, so it can't update itself" };
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => undefined);
    const upstream = await git(["rev-parse", "--abbrev-ref", "@{u}"]).catch(() => "");
    if (!upstream) return { ...base, branch, blocked: `${branch ?? "this branch"} doesn't follow a branch on a remote` };
    try {
      await git(["fetch", "--quiet", upstream.split("/")[0]], 60_000);
    } catch (e) {
      return { ...base, branch, error: `couldn't reach the remote: ${(e as Error).message.split("\n")[0]}` };
    }
    const latest = await git(["rev-parse", "@{u}"]);
    const changes = await changesBetween(current, latest).catch(() => []);
    const behind = Number(await git(["rev-list", "--count", "HEAD..@{u}"]).catch(() => "0"));
    const ahead = Number(await git(["rev-list", "--count", "@{u}..HEAD"]).catch(() => "0"));
    const dirty = (await git(["status", "--porcelain", "--untracked-files=no"]).catch(() => "")).length > 0;
    const blocked = dirty ? "cockpit's folder has changes of yours that aren't committed" : ahead ? `it has ${ahead} commit${ahead === 1 ? "" : "s"} of its own that ${upstream} doesn't` : undefined;
    return { ...base, branch, latest, behind, changes, blocked };
  })()
    .then((s) => {
      const news = s.behind !== last?.behind || s.latest !== last?.latest;
      last = s;
      if (news) broadcast({ type: "update", status: s });
      return s;
    })
    .finally(() => (checking = undefined));
  return checking;
}

let updating: Job | undefined;
export const updateJob = () => (updating?.code === undefined ? updating : undefined);

// the nodes' own updates, set by the hub's link code so this file doesn't need it
let updateNodes: () => Promise<string[]> = async () => [];
export const useNodeUpdates = (fn: typeof updateNodes) => void (updateNodes = fn);

// Pulls, installs and builds, then restarts when a service runs it. Returns the job that shows how it goes.
export async function applyUpdate(opts: { nodes?: boolean } = {}): Promise<Job> {
  if (updateJob()) return updating!;
  const s = await updateStatus(true);
  if (s.blocked) throw Object.assign(new Error(`It can't update itself: ${s.blocked}.`), { status: 409 });
  if (!s.behind) throw Object.assign(new Error("It's up to date."), { status: 409 });
  const notes = opts.nodes === false ? [] : await updateNodes();
  const pnpm = `"$(command -v pnpm || echo 'npx --yes pnpm@11')"`;
  const script = [...notes.map((n) => `echo ${JSON.stringify(n)}`), "set -e", "git pull --ff-only", `${pnpm} install --frozen-lockfile`, `${pnpm} build`].join("\n");
  updating = startJob("Updating cockpit", script, paths.root, (job) => {
    if (job.code !== 0) return broadcast({ type: "update", status: { ...s, error: "The update failed; its output says why." } });
    broadcast({ type: "update", status: { ...s, behind: 0, changes: [], restarting: s.service } });
    // the new code runs once the service brings it back; the screens get a moment to hear why it went away
    if (s.service) setTimeout(() => process.exit(75), 1500);
  });
  return updating;
}

// Updates by itself, when Settings says to and nothing is working: no busy session, no running task
let busy: () => Promise<boolean> = async () => true;
export const useBusyCheck = (fn: typeof busy) => void (busy = fn);

export function startUpdates() {
  const tick = async () => {
    const s = await updateStatus();
    if (!getSettings().updates.auto || !s.behind || s.blocked || !s.service || (await busy())) return;
    console.log(`update: ${s.behind} new commit${s.behind === 1 ? "" : "s"}, updating`);
    await applyUpdate().catch((e) => console.error("update:", (e as Error).message));
  };
  setTimeout(() => void tick().catch(() => {}), 2 * 60_000);
  setInterval(() => void tick().catch(() => {}), 20 * 60_000).unref();
}
