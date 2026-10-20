import type { Cockpit, PrRef, PullRequest } from "@cockpit/shared";

const PR_FIELDS = "number,title,url,headRefName,state,isDraft,reviewDecision,statusCheckRollup,createdAt,mergedAt,author";

function checks(rollup: any[] | undefined): PullRequest["checks"] {
  if (!rollup?.length) return "none";
  const states = rollup.map((r) => r.conclusion || r.state || r.status);
  if (states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(s))) return "fail";
  if (states.some((s) => ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING", ""].includes(s ?? ""))) return "pending";
  return "pass";
}

// The part of a failed job's log worth reading: up to the last ##[error] line, with gh's
// "job\tstep\ttimestamp" prefix trimmed off.
export function errorTail(log: string, lines = 120) {
  const all = log
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+Z /, ""));
  let end = all.findLastIndex((l) => l.includes("##[error]"));
  if (end === -1) end = all.length - 1;
  return all.slice(Math.max(0, end - lines + 1), end + 1).join("\n").trim();
}

export default function setup(k: Cockpit) {
  const repo = () => {
    const r = k.setting<string>("repo");
    if (!r) throw Object.assign(new Error("set the repository in Settings → Plugins → GitHub"), { status: 400 });
    return r;
  };
  const gh = (args: string[]) => k.run("gh", args);
  const ghJson = async <T = any>(args: string[]) => JSON.parse(await gh(args)) as T;

  const toPr = (p: any): PullRequest => ({
    number: p.number,
    title: p.title,
    url: p.url,
    branch: p.headRefName,
    state: p.state,
    isDraft: p.isDraft,
    reviewDecision: p.reviewDecision || undefined,
    checks: checks(p.statusCheckRollup),
    createdAt: p.createdAt,
    mergedAt: p.mergedAt || undefined,
    author: p.author?.login,
    ticket: k.ticketOf(p.headRefName, p.title),
  });

  const me = () => k.cache("me", 24 * 3600_000, async () => (await gh(["api", "user", "--jq", ".login"])).trim());

  k.codeHost({
    name: "GitHub",
    // PR state moves faster than tickets, but it still only refreshes when asked or after half an hour
    myPrs: (fresh) => k.cache("mine", 30 * 60_000, async () => (await ghJson<any[]>(["pr", "list", "-R", repo(), "--author", "@me", "--state", "all", "--limit", "60", "--json", PR_FIELDS])).map(toPr), fresh),
    reviewQueue: (fresh) =>
      k.cache("review", 30 * 60_000, async () => (await ghJson<any[]>(["pr", "list", "-R", repo(), "--search", "review-requested:@me", "--state", "open", "--limit", "40", "--json", PR_FIELDS])).map(toPr), fresh),
    deploys: (since) =>
      k.cache(`runs:${since}`, 10 * 60_000, async () => {
        const runs = await ghJson<any[]>(["run", "list", "-R", repo(), "--created", `>=${since}`, "--limit", "300", "--json", "workflowName,headBranch,event,conclusion,createdAt,displayTitle,url"]);
        return runs.filter((r) => /deploy|build/i.test(r.workflowName) && ["main", "master", "staging"].includes(r.headBranch)).map((r) => ({ ...r, ticket: k.ticketOf(r.displayTitle, r.headBranch) }));
      }),
    async failingChecks(n) {
      const all: { name: string; state: string; link: string }[] = await ghJson(["pr", "checks", String(n), "-R", repo(), "--json", "name,state,link"]).catch(() => []);
      const bad = all.filter((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"].includes(c.state));
      return Promise.all(
        bad.slice(0, 3).map(async (c) => {
          const m = c.link.match(/runs\/(\d+)\/job\/(\d+)/);
          const log = m ? await gh(["run", "view", m[1], "--job", m[2], "--log-failed", "-R", repo()]).catch(() => "") : "";
          return { ...c, tail: errorTail(log) };
        }),
      );
    },
    parsePr(input) {
      const s = input.trim();
      const m = s.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
      if (m) return { repo: m[1], n: Number(m[2]) };
      const n = s.match(/^#?(\d+)$/);
      const r = k.setting<string>("repo");
      if (n && r) return { repo: r, n: Number(n[1]) };
    },
    async prInfo({ repo, n }: PrRef) {
      const p = await ghJson(["pr", "view", String(n), "-R", repo, "--json", "title,author,additions,deletions,changedFiles,headRefOid,headRefName,url,state,isDraft"]);
      return { ...p, author: p.author?.login as string };
    },
    async pendingReview({ repo, n }: PrRef) {
      const [login, reviews] = await Promise.all([me(), ghJson<any[]>(["api", `repos/${repo}/pulls/${n}/reviews`, "--paginate"])]);
      const r = reviews.find((x) => x.state === "PENDING" && x.user?.login === login);
      if (!r) return;
      const comments = await ghJson<any[]>(["api", `repos/${repo}/pulls/${n}/reviews/${r.id}/comments`, "--paginate"]).catch(() => []);
      return { id: r.id as number, url: r.html_url as string, comments: comments.length };
    },
    deletePending: ({ repo, n }: PrRef, id: number) => gh(["api", "-X", "DELETE", `repos/${repo}/pulls/${n}/reviews/${id}`]),
  });
}
