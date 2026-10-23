import type { Cockpit, CodeHost, LastReview, PrRef, PullRequest, Reviewer } from "@cockpit/shared";

const PR_FIELDS = "number,title,url,headRefName,baseRefName,headRefOid,state,isDraft,reviewDecision,statusCheckRollup,createdAt,mergedAt,author,mergeable,mergeStateStatus,reviewRequests,latestReviews";
// a closed PR's checks and reviews no longer change anything, and asking for them on dozens of PRs makes a response
// big enough that GitHub sometimes cuts it off ("unexpected end of JSON input")
const CLOSED_FIELDS = "number,title,url,headRefName,baseRefName,headRefOid,state,isDraft,reviewDecision,createdAt,mergedAt,author";

const FAILED = ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"];
// a check run has a name, a commit status a context
const checkName = (r: any): string => r.name || r.context || "";

// "dependency-check", "security-audit-*": names, with * for anything, matched without caring about case
export function ignoring(patterns: string[] | string | undefined) {
  const list = Array.isArray(patterns) ? patterns : String(patterns ?? "").split(/[,\n]/);
  const res = list.map((p) => p.trim()).filter(Boolean).map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i"));
  return (name: string) => res.some((re) => re.test(name));
}

export function checks(rollup: any[] | undefined): PullRequest["checks"] {
  if (!rollup?.length) return "none";
  const states = rollup.map((r) => r.conclusion || r.state || r.status);
  if (states.some((s) => FAILED.includes(s))) return "fail";
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

// asked and not answered yet, then each reviewer's latest word; a team request has a slug instead of a login
export function reviewersOf(p: { reviewRequests?: any[]; latestReviews?: any[] }): Reviewer[] {
  const out: Reviewer[] = [];
  for (const r of p.reviewRequests ?? []) {
    const login = r.login ?? r.slug;
    if (login) out.push({ name: r.name || login, login: r.login, state: "REQUESTED", source: "GitHub" });
  }
  for (const r of p.latestReviews ?? []) {
    const login = r.author?.login;
    if (!login || out.some((x) => x.login === login)) continue;
    out.push({ name: login, login, state: r.state, source: "GitHub", at: r.submittedAt || undefined });
  }
  return out;
}

export default function setup(k: Cockpit) {
  const repo = () => {
    const r = k.setting<string>("repo");
    if (!r) throw Object.assign(new Error("set the repository in Settings → Plugins → GitHub"), { status: 400 });
    return r;
  };
  // GitHub's API now and then drops a big response or times out; one more try usually gets it
  const gh = (args: string[]) => k.run("gh", args).catch(async (e: Error) => {
    if (!/unexpected end of JSON|timeout|timed out|502|503|504|EOF|connection reset/i.test(e.message)) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return k.run("gh", args);
  });
  const ghJson = async <T = any>(args: string[]) => JSON.parse(await gh(args)) as T;

  const ignored = () => ignoring(k.setting<string[]>("ignoredChecks"));
  const toPr = (p: any): PullRequest => {
    const skip = ignored();
    const rollup: any[] = p.statusCheckRollup ?? [];
    const off = [...new Set(rollup.filter((r) => skip(checkName(r)) && FAILED.includes(r.conclusion || r.state || r.status)).map(checkName))];
    return {
    number: p.number,
    title: p.title,
    url: p.url,
    branch: p.headRefName,
    base: p.baseRefName,
    state: p.state,
    isDraft: p.isDraft,
    reviewDecision: p.reviewDecision || undefined,
    checks: checks(rollup.filter((r) => !skip(checkName(r)))),
    ignoredFailing: off.length ? off : undefined,
    createdAt: p.createdAt,
    mergedAt: p.mergedAt || undefined,
    author: p.author?.login,
    ticket: k.ticketOf(p.headRefName, p.title),
    mergeable: p.mergeable || undefined,
    mergeState: p.mergeStateStatus || undefined,
    headSha: p.headRefOid || undefined,
    reviewers: reviewersOf(p),
    };
  };

  // Each check of your open PRs that finished becomes a ci run on the Runs screen, once per check per commit
  const recordChecks = (prs: any[]) => {
    const before = k.store.get<string[]>("ciSeen");
    const seen = new Set(before ?? []);
    const added: string[] = [];
    for (const p of prs.filter((x) => x.state === "OPEN")) {
      for (const c of (p.statusCheckRollup ?? []) as any[]) {
        const state = c.conclusion || c.state || "";
        const status = ["SUCCESS"].includes(state) ? "pass" : FAILED.includes(state) || state === "STARTUP_FAILURE" ? "fail" : state === "CANCELLED" ? "cancelled" : undefined;
        // still going, skipped or neutral: nothing to record
        if (!status || !checkName(c)) continue;
        const key = `${p.number}:${p.headRefOid}:${checkName(c)}:${c.completedAt || c.startedAt || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        added.push(key);
        const started = Date.parse(c.startedAt || "") || undefined;
        k.runs.record({
          kind: "ci",
          name: checkName(c),
          branch: p.headRefName,
          ticket: k.ticketOf(p.headRefName, p.title),
          status,
          startedAt: started,
          endedAt: Date.parse(c.completedAt || "") || started,
          // the first time, every check already done on your PRs comes in at once; those failures aren't news
          quiet: !before || ignored()(checkName(c)),
          meta: { url: c.detailsUrl || c.targetUrl || undefined, pr: p.number, prUrl: p.url, sha: p.headRefOid, workflow: c.workflowName || undefined, ignored: ignored()(checkName(c)) || undefined },
        });
      }
    }
    if (added.length) k.store.set("ciSeen", [...seen].slice(-3000));
  };

  const me = () => k.cache("me", 24 * 3600_000, async () => (await gh(["api", "user", "--jq", ".login"])).trim());

  const host: CodeHost = {
    name: "GitHub",
    // PR state moves faster than tickets, but it still only refreshes when asked or after half an hour
    myPrs: (fresh) =>
      k.cache(
        "mine",
        30 * 60_000,
        async () => {
          const list = (state: string, limit: number, fields: string) => ghJson<any[]>(["pr", "list", "-R", repo(), "--author", "@me", "--state", state, "--limit", String(limit), "--json", fields]);
          // "closed" includes the merged ones
          const [open, closed] = await Promise.all([list("open", 60, PR_FIELDS), list("closed", 60, CLOSED_FIELDS)]);
          try {
            recordChecks(open);
          } catch (e) {
            k.log("recording checks as runs failed:", e);
          }
          return [...open, ...closed].sort((a, b) => b.number - a.number).slice(0, 60).map(toPr);
        },
        fresh,
      ),
    reviewQueue: (fresh) =>
      k.cache("review", 30 * 60_000, async () => (await ghJson<any[]>(["pr", "list", "-R", repo(), "--search", "review-requested:@me", "--state", "open", "--limit", "40", "--json", PR_FIELDS])).map(toPr), fresh),
    deploys: (since) =>
      k.cache(`runs:${since}`, 10 * 60_000, async () => {
        const runs = await ghJson<any[]>(["run", "list", "-R", repo(), "--created", `>=${since}`, "--limit", "300", "--json", "workflowName,headBranch,event,conclusion,createdAt,displayTitle,url"]);
        return runs.filter((r) => /deploy|build/i.test(r.workflowName) && ["main", "master", "staging"].includes(r.headBranch)).map((r) => ({ ...r, ticket: k.ticketOf(r.displayTitle, r.headBranch) }));
      }),
    async failingChecks(n) {
      const all: { name: string; state: string; link: string }[] = await ghJson(["pr", "checks", String(n), "-R", repo(), "--json", "name,state,link"]).catch(() => []);
      const skip = ignored();
      const bad = all.filter((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"].includes(c.state) && !skip(c.name));
      return Promise.all(
        bad.slice(0, 3).map(async (c) => {
          const m = c.link.match(/runs\/(\d+)\/job\/(\d+)/);
          const log = m ? await gh(["run", "view", m[1], "--job", m[2], "--log-failed", "-R", repo()]).catch(() => "") : "";
          return { ...c, tail: errorTail(log) };
        }),
      );
    },
    async reviewThreads(n) {
      const [owner, name] = repo().split("/");
      const query = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved path line comments(first:20){nodes{author{login} body}}}}}}}`;
      const d = await ghJson<any>(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${n}`]);
      const threads: any[] = d?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      return threads
        .filter((t) => !t.isResolved)
        .flatMap((t) => t.comments.nodes.map((c: any) => ({ path: t.path ?? undefined, line: t.line ?? undefined, author: c.author?.login, body: c.body })));
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
      const p = await ghJson(["pr", "view", String(n), "-R", repo, "--json", "title,author,additions,deletions,changedFiles,headRefOid,headRefName,baseRefName,url,state,isDraft"]);
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
    // the queue asks for each PR in it, so it's kept for a few minutes
    lastReview: ({ repo, n }: PrRef) =>
      k.cache(`last:${repo}:${n}`, 5 * 60_000, async (): Promise<LastReview | null> => {
        const [login, reviews, pr] = await Promise.all([me(), ghJson<any[]>(["api", `repos/${repo}/pulls/${n}/reviews`, "--paginate"]), ghJson<any>(["pr", "view", String(n), "-R", repo, "--json", "headRefOid"])]);
        const mine = reviews.filter((x) => x.user?.login === login && x.state !== "PENDING" && x.commit_id);
        const last = mine.at(-1);
        // null rather than undefined, which the cache can't keep
        if (!last) return null;
        const head: string = pr.headRefOid;
        // a reviewed commit that a force-push dropped can't be compared; behind means the branch no longer holds it
        const cmp = head === last.commit_id ? { status: "identical", ahead: 0, behind: 0, files: 0 } : await ghJson<any>(["api", `repos/${repo}/compare/${last.commit_id}...${head}`, "--jq", "{status, ahead: .ahead_by, behind: .behind_by, files: (.files | length)}"]).catch(() => undefined);
        // every comment you started, from any of your reviews; replies are part of a thread someone else opened
        const comments = await ghJson<any[]>(["api", `repos/${repo}/pulls/${n}/comments`, "--paginate"]).catch(() => []);
        const bodies = mine.filter((r) => r.body?.trim()).map((r) => ({ author: login, body: r.body as string }));
        return {
          commit: last.commit_id as string,
          head,
          at: last.submitted_at as string,
          state: last.state as string,
          url: last.html_url as string,
          commits: cmp?.ahead ?? 0,
          files: cmp?.files ?? 0,
          rewritten: !cmp || cmp.behind > 0,
          comments: [...bodies, ...comments.filter((c) => c.user?.login === login && !c.in_reply_to_id).map((c) => ({ path: c.path, line: c.line ?? c.original_line ?? undefined, author: login, body: c.body as string }))],
        };
      }).then((r) => r ?? undefined),
    // asking someone who already reviewed is how GitHub re-requests a review
    requestReview: (n, logins) => gh(["pr", "edit", String(n), "-R", repo(), "--add-reviewer", logins.join(",")]),
  };
  k.codeHost(host);

  // "Run something": re-running the failed CI of the worktree's open PR, offered only once some check failed
  const openPr = async (branch?: string) => {
    if (!branch || !k.setting<string>("repo")) return;
    return (await host.myPrs(false)).find((p) => p.state === "OPEN" && p.branch === branch);
  };
  // the workflow runs of the PR's latest commit that ended badly; gh only re-runs ones that finished
  const failedRuns = async (branch: string, sha?: string) => {
    const runs = await ghJson<any[]>(["run", "list", "-R", repo(), "--branch", branch, "--limit", "50", "--json", "databaseId,conclusion,status,headSha,workflowName"]);
    const latest = sha ?? runs[0]?.headSha;
    return runs.filter((r) => r.headSha === latest && r.status === "completed" && ["failure", "timed_out", "cancelled", "startup_failure"].includes(r.conclusion));
  };
  // a cockpit from before "Run something" has no k.runOptions
  k.runOptions?.({
    async list(wt) {
      const pr = await openPr(wt.branch);
      if (!pr || pr.checks !== "fail") return [];
      return [{ id: `rerun:${pr.number}`, kind: "ci", label: `Re-run failed CI checks on #${pr.number}`, detail: `gh run rerun --failed, for ${pr.branch}`, group: "GitHub" }];
    },
    // with k.run rather than in a terminal, so a token set here works as well as a gh login
    async start(id, wt) {
      const pr = await openPr(wt.branch);
      if (!pr || id !== `rerun:${pr.number}`) throw Object.assign(new Error("that PR is no longer open"), { status: 400 });
      const runs = await failedRuns(pr.branch, pr.headSha);
      if (!runs.length) throw Object.assign(new Error(`nothing failed on #${pr.number}'s latest commit that GitHub can re-run`), { status: 400 });
      const r = k.runs.start({ kind: "ci", name: `Re-run failed checks on #${pr.number}`, branch: pr.branch, worktree: wt.path, ticket: wt.ticket ?? pr.ticket, command: `gh run rerun --failed (${runs.length} workflow runs)`, meta: { url: pr.url, pr: pr.number } });
      void (async () => {
        let failed = 0;
        for (const w of runs) {
          const out = await gh(["run", "rerun", String(w.databaseId), "--failed", "-R", repo()]).then(
            (o) => `${w.workflowName}: re-running its failed jobs${o.trim() ? `\n${o.trim()}` : ""}`,
            (e: Error) => (failed++, `${w.workflowName}: ${e.message}`),
          );
          k.runs.event(r.id, { lines: out.split("\n") });
        }
        k.runs.event(r.id, { lines: [failed ? `${failed} of ${runs.length} didn't start` : "The checks show up on the PR as they run."], result: { status: failed ? 1 : 0 }, phase: "done" });
      })().catch((e: Error) => k.runs.event(r.id, { error: e.message, phase: "failed" }));
      return { runId: r.id };
    },
  });
}
