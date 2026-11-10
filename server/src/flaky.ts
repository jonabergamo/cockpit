// Flaky checks: the same check passing and failing on the same code. A check is its runs of one kind and name; the
// code is the commit it ran on, so only runs that say theirs count for flips (a CI check, or a local run on a tree with
// nothing uncommitted). Proofs aren't checks: running one again and again is how it gets made.
import type { FlakyCheck, RunKind } from "@cockpit/shared";
import { db } from "./db.ts";
import { getSettings, type Settings } from "./settings.ts";

export type FlakyRules = Settings["runs"]["flaky"];

export interface FlakyInput {
  kind: RunKind;
  name: string;
  status: string;
  startedAt: number;
  // the commit, only when the run is known to have run exactly it
  sha?: string;
  failing?: string[];
}

const pct = (n: number) => Math.round(n * 100);

export function flakiness(runs: FlakyInput[], rules: FlakyRules): FlakyCheck[] {
  const groups = new Map<string, FlakyInput[]>();
  for (const r of runs) {
    if (r.kind === "proof" || (r.status !== "pass" && r.status !== "fail")) continue;
    const key = `${r.kind}\n${r.name}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: FlakyCheck[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.startedAt - b.startedAt);
    const fails = list.filter((r) => r.status === "fail");
    const passes = list.length - fails.length;
    const bySha = new Map<string, FlakyInput[]>();
    for (const r of list) if (r.sha) bySha.set(r.sha, [...(bySha.get(r.sha) ?? []), r]);
    const flipped = new Set<string>();
    let lastFlip: number | undefined;
    for (const [sha, same] of bySha) {
      if (!same.some((r) => r.status === "pass") || !same.some((r) => r.status === "fail")) continue;
      flipped.add(sha);
      // when it last came out differently from the run before it on that commit
      for (let i = 1; i < same.length; i++) if (same[i].status !== same[i - 1].status) lastFlip = Math.max(lastFlip ?? 0, same[i].startedAt);
    }
    const rate = fails.length / list.length;
    const byRate = list.length >= rules.minRuns && pct(rate) >= rules.minFailPct && pct(rate) <= rules.maxFailPct;
    if (!flipped.size && !byRate) continue;
    const tests = new Map<string, { name: string; fails: number; shas: Set<string> }>();
    for (const r of fails)
      for (const t of r.failing ?? []) {
        const e = tests.get(t) ?? { name: t, fails: 0, shas: new Set<string>() };
        e.fails++;
        if (r.sha && flipped.has(r.sha)) e.shas.add(r.sha);
        tests.set(t, e);
      }
    const times = (n: number) => (n === 1 ? "once" : `${n} times`);
    out.push({
      kind: list[0].kind,
      name: list[0].name,
      runs: list.length,
      fails: fails.length,
      passes,
      flips: flipped.size,
      lastFlip,
      lastFail: fails.at(-1)?.startedAt,
      why: [flipped.size ? `passed and failed on the same commit ${times(flipped.size)}` : "", byRate ? `fails ${pct(rate)}% of its ${list.length} runs` : ""].filter(Boolean).join(", and "),
      tests: [...tests.values()]
        .map((t) => ({ name: t.name, fails: t.fails, flips: t.shas.size }))
        .sort((a, b) => b.flips - a.flips || b.fails - a.fails)
        .slice(0, 10),
    });
  }
  return out.sort((a, b) => Math.max(b.lastFlip ?? 0, b.lastFail ?? 0) - Math.max(a.lastFlip ?? 0, a.lastFail ?? 0));
}

interface Row {
  kind: string;
  name: string;
  status: string;
  started_at: number;
  sha: string | null;
  dirty: number | null;
  failing: string | null;
}

// worked out again at most every half a minute: the Runs screen, each failure and autopilot all ask
let memo: { at: number; key: string; checks: FlakyCheck[] } | undefined;

export function flakyChecks(now = Date.now()): FlakyCheck[] {
  const rules = getSettings().runs.flaky;
  const key = JSON.stringify(rules);
  if (memo && memo.key === key && now - memo.at < 30_000) return memo.checks;
  const rows = db
    .prepare<[number], Row>(
      `select kind, name, status, started_at, json_extract(meta, '$.sha') as sha, json_extract(meta, '$.dirty') as dirty, json_extract(summary, '$.failing') as failing
       from runs where started_at > ? and kind != 'proof' and status in ('pass', 'fail') order by started_at desc limit 5000`,
    )
    .all(now - rules.days * 864e5);
  const runs: FlakyInput[] = rows
    // a local run counts once it's known to have run a commit as it is; older ones never said
    .filter((r) => r.kind === "ci" || r.dirty === 0)
    .map((r) => ({ kind: r.kind as RunKind, name: r.name, status: r.status, startedAt: r.started_at, sha: r.sha ?? undefined, failing: r.failing ? (JSON.parse(r.failing) as string[]) : undefined }));
  const checks = flakiness(runs, rules);
  memo = { at: now, key, checks };
  return checks;
}

export const forgetFlaky = () => void (memo = undefined);

export const flakyOf = (kind: RunKind, name: string) => flakyChecks().find((c) => c.kind === kind && c.name === name);

// what to say about it, in a message to the agent or a notification
export const flakyNote = (c: FlakyCheck) => `${c.name} is known to be flaky: it ${c.why} (${c.fails} failed and ${c.passes} passed lately).`;
