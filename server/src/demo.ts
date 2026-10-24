// Fake data for COCKPIT_DEMO=1, used for screenshots and the launch video. Nothing here touches Jira, GitHub or ~/.claude.
import type { Hono } from "hono";
import type { AskInfo, BoardCard, Entry, PullRequest, Session, Task, Ticket, WorkflowRun, Worktree } from "@cockpit/shared";
import { columnOf, matchWorker } from "./board.ts";
import { paths } from "./config.ts";
import { broadcast } from "./hub.ts";
import { burndown, burnup, distribution, people, spans, workdays, type Transition } from "./report.ts";
import { pluginScreens, pluginThemes } from "./plugins.ts";
import { getSettings } from "./settings.ts";
import { day } from "./util.ts";

const H = 3600_000;
const now = Date.now();
const iso = (t: number) => new Date(t).toISOString();
const wt = (key: string) => `/home/dev/worktrees/${key}/acme`;

const sprintStart = new Date(now - 6 * 24 * H);
sprintStart.setHours(9, 0, 0, 0);
const sprintEnd = new Date(sprintStart.getTime() + 13 * 24 * H);
const sprint = { id: 24, name: "Sprint 24", start: iso(+sprintStart), end: iso(+sprintEnd), goal: "Checkout redesign and faster search", state: "active" };

const tickets: (Ticket & { statusChangedAt?: string })[] = [
  { key: "ACME-412", summary: "Saved cards on the checkout page", status: "In Progress", points: 3, inSprint: true, type: "Story" },
  { key: "ACME-418", summary: "Search results load in under 300ms", status: "Review", points: 2, inSprint: true, type: "Story" },
  { key: "ACME-405", summary: "Apple Pay button on mobile web", status: "QA", points: 2, inSprint: true, type: "Story" },
  { key: "ACME-399", summary: "Fix basket total rounding for discounts", status: "Done", points: 1, inSprint: true, type: "Bug" },
  { key: "ACME-401", summary: "Order history filters", status: "Done", points: 2, inSprint: true, type: "Story" },
  { key: "ACME-407", summary: "Remove the legacy promo banner", status: "Ready to release", points: 1, inSprint: true, type: "Task" },
  { key: "ACME-420", summary: "Empty state for the wishlist", status: "To Do", points: 1, inSprint: true, type: "Story" },
  { key: "ACME-423", summary: "Spike: offline basket sync", status: "To Do", points: 2, inSprint: true, type: "Spike" },
  { key: "ACME-409", summary: "Address autocomplete on signup", status: "Blocked", points: 2, inSprint: true, type: "Story" },
  { key: "ACME-388", summary: "Dark mode for the account area", status: "To Do", inSprint: false, type: "Story" },
].map((t) => ({ ...t, statusCategory: t.status === "Done" ? "done" : t.status === "To Do" ? "new" : "indeterminate", url: `https://example.atlassian.net/browse/${t.key}` }));

const steps: Record<string, [string, number][]> = {
  "ACME-399": [["In Progress", 0.2], ["Review", 0.8], ["QA", 1.3], ["Done", 2.1]],
  "ACME-401": [["In Progress", 0.3], ["Review", 1.9], ["QA", 3.0], ["Done", 4.1]],
  "ACME-407": [["In Progress", 2.2], ["Review", 2.9], ["Ready to release", 5.1]],
  "ACME-405": [["In Progress", 1.0], ["Review", 3.2], ["QA", 5.3]],
  "ACME-418": [["In Progress", 2.0], ["Review", 5.6]],
  "ACME-412": [["In Progress", 3.9]],
  "ACME-409": [["In Progress", 1.1], ["Blocked", 2.4]],
  "ACME-420": [["To Do", 0]],
  "ACME-423": [["To Do", 0]],
};
// the rest of the team, only used by the sprint report
const teammates: (Ticket & { statusChangedAt?: string })[] = (
  [
    ["ACME-430", "Sam Rivera", "Product page reviews", "Done", 3, [["In Progress", 0.1], ["Review", 1.5], ["Done", 3.0]]],
    ["ACME-431", "Sam Rivera", "Gift cards at checkout", "In Progress", 3, [["In Progress", 2.5]]],
    ["ACME-432", "Sam Rivera", "Shipping cost estimate", "To Do", 2, [["To Do", 0]]],
    ["ACME-433", "Priya Shah", "Search filters on mobile", "QA", 3, [["In Progress", 0.5], ["Review", 3.1], ["QA", 4.6]]],
    ["ACME-434", "Priya Shah", "Recently viewed products", "Review", 2, [["In Progress", 2.0], ["Review", 5.2]]],
    ["ACME-435", "Priya Shah", "Fix wishlist sync on login", "Done", 1, [["In Progress", 0.2], ["Done", 0.9]]],
    ["ACME-436", "Tom Becker", "Newsletter signup on the footer", "In Progress", 2, [["In Progress", 4.0]]],
    ["ACME-437", "Tom Becker", "Order emails in Spanish", "To Do", 3, [["To Do", 0]]],
    ["ACME-438", "Tom Becker", "Track checkout errors", "Blocked", 1, [["In Progress", 1.0], ["Blocked", 3.4]]],
  ] as [string, string, string, string, number, [string, number][]][]
).map(([key, assignee, summary, status, points, st]) => {
  steps[key] = st;
  return { key, assignee, summary, status, points, inSprint: true, type: "Story", statusCategory: status === "Done" ? "done" : status === "To Do" ? "new" : "indeterminate", url: `https://example.atlassian.net/browse/${key}` };
});

const history = new Map<string, Transition[]>(
  Object.entries(steps).map(([key, list]) => [key, list.map(([to, d]) => ({ key, to, at: iso(+sprintStart + d * 24 * H) }))]),
);

const pr = (n: number, ticket: string, title: string, state: string, extra: Partial<PullRequest> = {}): PullRequest => ({
  number: n,
  title,
  url: `https://github.com/acme/shop/pull/${n}`,
  branch: `feat/${ticket}/x`,
  base: "main",
  state,
  isDraft: false,
  checks: "pass",
  createdAt: iso(now - 30 * H),
  ticket,
  author: "you",
  ...extra,
});

const prs = {
  mine: [
    pr(1288, "ACME-418", "Faster search with a prefix index", "OPEN", { reviewDecision: "REVIEW_REQUIRED", createdAt: iso(now - 20 * H) }),
    pr(1285, "ACME-405", "Apple Pay button on mobile web", "OPEN", { reviewDecision: "APPROVED", createdAt: iso(now - 50 * H) }),
    pr(1291, "ACME-412", "Saved cards, first pass", "OPEN", { isDraft: true, checks: "fail", createdAt: iso(now - 3 * H) }),
    pr(1279, "ACME-407", "Remove the legacy promo banner", "MERGED", { mergedAt: iso(now - 26 * H), createdAt: iso(now - 70 * H) }),
    pr(1270, "ACME-401", "Order history filters", "MERGED", { mergedAt: iso(now - 50 * H), createdAt: iso(now - 98 * H) }),
  ],
  review: [pr(1290, "ACME-415", "Cache product images at the edge", "OPEN", { author: "sam", createdAt: iso(now - 5 * H) })],
};

const worktrees: Worktree[] = [
  { path: "/home/dev/acme", name: "acme", branch: "main", head: "a1b2c3d4e5", main: true, dirty: 0, ahead: 0, behind: 0, lastCommitAt: now - 5 * H, lastCommitSubject: "chore: bump deps" },
  { path: wt("ACME-412"), name: "ACME-412", branch: "feat/ACME-412/saved-cards", head: "f00ba7", main: false, ticket: "ACME-412", dirty: 6, ahead: 3, behind: 0, lastCommitAt: now - 2 * H, sizeBytes: 812e6 },
  { path: wt("ACME-418"), name: "ACME-418", branch: "feat/ACME-418/fast-search", head: "c0ffee", main: false, ticket: "ACME-418", dirty: 0, ahead: 5, behind: 2, lastCommitAt: now - 20 * H, sizeBytes: 790e6 },
  { path: wt("ACME-405"), name: "ACME-405", branch: "feat/ACME-405/apple-pay", head: "beef01", main: false, ticket: "ACME-405", dirty: 0, ahead: 4, behind: 6, lastCommitAt: now - 49 * H, sizeBytes: 804e6 },
  { path: wt("ACME-401"), name: "ACME-401", branch: "feat/ACME-401/order-filters", head: "abc123", main: false, ticket: "ACME-401", dirty: 0, ahead: 0, behind: 14, lastCommitAt: now - 99 * H, sizeBytes: 1.1e9 },
  { path: wt("ACME-407"), name: "ACME-407", branch: "feat/ACME-407/no-promo", head: "def456", main: false, ticket: "ACME-407", dirty: 0, ahead: 0, behind: 9, lastCommitAt: now - 71 * H, sizeBytes: 760e6 },
];

const session = (id: string, title: string, ticket: string | undefined, status: Session["status"], startedAgo: number, updatedAgo: number, cost: number): Session => ({
  id,
  project: "demo",
  cwd: ticket ? wt(ticket) : "/home/dev/acme",
  title,
  status,
  pid: status === "ended" ? undefined : 4000 + id.charCodeAt(0),
  startedAt: now - startedAgo * H,
  updatedAt: now - updatedAgo * H,
  branch: ticket ? worktrees.find((w) => w.ticket === ticket)?.branch : "main",
  ticket,
  worktree: ticket ? wt(ticket) : undefined,
  costUSD: cost,
  linesAdded: Math.round(cost * 40),
  linesRemoved: Math.round(cost * 12),
  size: 1,
});

const sessions: Session[] = [
  session("d1", "Saved cards on checkout", "ACME-412", "busy", 3, 0, 4.12),
  { ...session("d2", "Prefix index for search", "ACME-418", "waiting", 6, 0.3, 6.8), waitingFor: "input needed" },
  session("d3", "Apple Pay review fixes", "ACME-405", "idle", 2, 0.8, 1.94),
  session("d4", "Release notes for sprint 24", undefined, "busy", 0.6, 0, 0.42),
  session("d5", "Order history filters", "ACME-401", "ended", 100, 96, 9.3),
  session("d6", "Basket rounding bug", "ACME-399", "ended", 140, 134, 2.2),
  session("d7", "Promo banner cleanup", "ACME-407", "ended", 74, 70, 1.1),
];

const script: Omit<Entry, "id" | "ts">[] = [
  { kind: "user", text: "Add saved cards to the checkout page. Cards come from GET /api/cards. Keep the current form as the fallback." } as never,
  { kind: "assistant", text: "I'll look at how checkout loads payment methods today, then add a saved cards list above the card form." } as never,
  { kind: "tool", toolUseId: "t1", name: "Grep", input: { pattern: "PaymentForm", path: "src/checkout" } } as never,
  { kind: "tool_result", toolUseId: "t1", text: "src/checkout/PaymentForm.tsx\nsrc/checkout/CheckoutPage.tsx", isError: false } as never,
  { kind: "tool", toolUseId: "t2", name: "Read", input: { file_path: "src/checkout/CheckoutPage.tsx" } } as never,
  { kind: "tool_result", toolUseId: "t2", text: "export function CheckoutPage() {\n  const basket = useBasket();\n  return <PaymentForm total={basket.total} />;\n}", isError: false } as never,
  { kind: "assistant", text: "The page renders `PaymentForm` directly. I'll add a `useSavedCards` hook and a `SavedCards` list that falls back to the form when the list is empty." } as never,
  { kind: "tool", toolUseId: "t3", name: "Write", input: { file_path: "src/checkout/useSavedCards.ts", content: "export function useSavedCards() {...}" } } as never,
  { kind: "tool_result", toolUseId: "t3", text: "File created", isError: false } as never,
  { kind: "tool", toolUseId: "t4", name: "Edit", input: { file_path: "src/checkout/CheckoutPage.tsx", old_string: "return <PaymentForm total={basket.total} />;", new_string: "return cards.length ? <SavedCards cards={cards} /> : <PaymentForm total={basket.total} />;" } } as never,
  { kind: "tool_result", toolUseId: "t4", text: "Edited", isError: false } as never,
  { kind: "tool", toolUseId: "t5", name: "Bash", input: { command: "pnpm test checkout", description: "Run checkout tests" } } as never,
  { kind: "tool_result", toolUseId: "t5", text: "✓ 14 tests passed", isError: false } as never,
  { kind: "assistant", text: "Saved cards now show above the form, and the form stays as the fallback. Tests pass. Want me to add the delete card action next?" } as never,
];

const withIds = (list: typeof script, base: number): Entry[] => list.map((e, i) => ({ ...e, id: `demo-${base + i}`, ts: iso(now - (list.length - i) * 60_000) }) as Entry);

const run: WorkflowRun = {
  runId: "wf_demo",
  sessionId: "d2",
  project: "demo",
  name: "search-speedup",
  status: "completed",
  startTime: now - 26 * H,
  durationMs: 1_420_000,
  summary: "Profile search, try two index strategies, then review the winner",
  phases: [
    { title: "Profile", detail: "find where the time goes" },
    { title: "Try", detail: "one agent per strategy" },
    { title: "Review", detail: "check the winner for edge cases" },
  ],
  agents: [
    { label: "profile:api", phase: "Profile", state: "done", model: "claude-opus-5-5", tokens: 61_000, toolCalls: 18, durationMs: 210_000, resultPreview: "80% of the time is the LIKE query on product names" },
    { label: "try:prefix-index", phase: "Try", state: "done", model: "claude-opus-5-5", tokens: 88_000, toolCalls: 27, durationMs: 410_000, resultPreview: "p95 went from 1.4s to 180ms" },
    { label: "try:trigram", phase: "Try", state: "done", model: "claude-opus-5-5", tokens: 92_000, toolCalls: 31, durationMs: 450_000, resultPreview: "p95 240ms, index is 3x bigger" },
    { label: "review:winner", phase: "Review", state: "done", model: "claude-opus-5-5", tokens: 54_000, toolCalls: 15, durationMs: 300_000, resultPreview: "Prefix index wins. One edge case with accents, fixed." },
  ],
  agentCount: 4,
  totalTokens: 295_000,
  live: false,
};

function report(scope: "me" | "team" = "team") {
  const days = workdays(sprintStart, sprintEnd);
  const mine = tickets.filter((t) => t.inSprint).map((t) => ({ ...t, assignee: "Alex Doe" }));
  const sprintTickets = scope === "me" ? mine : [...mine, ...teammates];
  const points = burnup(sprintTickets, history, days);
  const released = points.filter((p) => !Number.isNaN(p.released)).at(-1)?.released ?? 0;
  const doneStatuses = ["QA", "Ready to release", "Done"];
  const devDone = burnup(sprintTickets, history, days, undefined, new Set(doneStatuses));
  return {
    sprint,
    tickets: sprintTickets.map((t) => ({ ...t, spans: spans(t.key, history.get(t.key) ?? []), costUSD: sessions.filter((s) => s.ticket === t.key).reduce((n, s) => n + (s.costUSD ?? 0), 0) || undefined, addedLate: t.key === "ACME-423" })),
    burnup: points,
    burndown: burndown(devDone),
    distribution: distribution(sprintTickets),
    doneStatuses,
    scope,
    people: people([...mine, ...teammates]).map((p) => ({ ...p, me: p.name === "Alex Doe" })),
    elapsedShare: +(days.filter((d) => d <= day(now)).length / days.length).toFixed(3),
    totals: { scope: sprintTickets.reduce((n, t) => n + (t.points ?? 0), 0), done: devDone.filter((p) => !Number.isNaN(p.released)).at(-1)?.released ?? 0, released, projected: 9.3, daysLeft: days.filter((d) => d > day(now)).length, daysTotal: days.length, byStatus: {} },
    releasedStatuses: ["Ready to release", "Done"],
    statusOrder: ["To Do", "In Progress", "Review", "QA", "Ready to release", "Done"],
  };
}

function activity() {
  return Array.from({ length: 8 }, (_, i) => {
    const date = day(now - i * 24 * H);
    const trans = [...history.values()].flat().filter((t) => day(t.at) === date && t.to !== "To Do");
    return {
      date,
      transitions: trans.map((t) => ({ key: t.key, to: t.to, at: t.at })),
      prsOpened: prs.mine.filter((p) => day(p.createdAt) === date),
      prsMerged: prs.mine.filter((p) => p.mergedAt && day(p.mergedAt) === date),
      sessions: sessions.filter((s) => day(s.updatedAt) === date).map((s) => ({ id: s.id, title: s.title, ticket: s.ticket, costUSD: s.costUSD })),
      commits: Array.from({ length: (i * 7) % 9 + 2 }, (_, j) => ({ sha: `${i}${j}abc`, subject: "feat: progress", at: iso(now - i * 24 * H - j * H), ticket: undefined })),
      costUSD: [3.4, 8.1, 12.6, 0, 0, 6.2, 9.9, 4.4][i],
    };
  });
}

const daily = `Yesterday
- ACME-418 Search results load in under 300ms moved to Review
- opened #1288 Faster search with a prefix index
- merged #1279 Remove the legacy promo banner

Today
- ACME-412 Saved cards on the checkout page (In Progress)
- ACME-405 Apple Pay button on mobile web (QA)

Blockers
- ACME-409 Address autocomplete on signup, waiting on the maps API key`;

const files = [
  { path: "/home/dev/.claude/CLAUDE.md", label: "CLAUDE.md", group: "global", mtime: now - 50 * H, size: 1800 },
  { path: "/home/dev/.claude/settings.json", label: "settings.json", group: "settings", mtime: now - 90 * H, size: 900 },
  { path: "/home/dev/.claude/skills/pr-workflow/SKILL.md", label: "pr-workflow", group: "skill", mtime: now - 20 * H, size: 4100 },
  { path: "/home/dev/.claude/skills/daily-notes/SKILL.md", label: "daily-notes", group: "skill", mtime: now - 140 * H, size: 2100 },
  { path: "/home/dev/.claude/projects/-home-dev-acme/memory/MEMORY.md", label: "MEMORY.md", group: "memory", project: "~/acme", mtime: now - 10 * H, size: 300 },
  { path: "/home/dev/.claude/projects/-home-dev-acme/memory/conventional-commits.md", label: "conventional-commits.md", group: "memory", project: "~/acme", mtime: now - 10 * H, size: 400 },
  { path: "/home/dev/.claude/projects/-home-dev-acme/memory/api-mocks.md", label: "api-mocks.md", group: "memory", project: "~/acme", mtime: now - 30 * H, size: 380 },
];

const fileText: Record<string, string> = {
  "/home/dev/.claude/CLAUDE.md": "# How I work\n\n- Small PRs, one ticket each\n- Conventional commits, lowercase subject\n- Run the tests for the app you touched before saying it's done\n",
  "/home/dev/.claude/projects/-home-dev-acme/memory/conventional-commits.md":
    "---\nname: conventional-commits\ndescription: every commit is `type: lowercase sentence`\nmetadata:\n  type: feedback\n---\n\nUse feat, fix, perf, refactor, docs, ci or chore.\n\n**Why:** the changelog is generated from them.\n**How to apply:** check the subject before committing.\n",
};

function usage() {
  const days = Array.from({ length: 31 }, (_, i) => {
    const date = day(now - (30 - i) * 24 * H);
    const weekend = [0, 6].includes(new Date(`${date}T12:00`).getDay());
    const costUSD = weekend ? +(Math.sin(i) * 3 + 4).toFixed(2) : +(40 + Math.sin(i * 1.7) * 25 + (i % 5) * 6).toFixed(2);
    return { date, costUSD, tokens: Math.round(costUSD * 2.4e6), output: Math.round(costUSD * 9e3) };
  });
  const heat = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 0 || d === 6 ? (h > 10 && h < 16 ? 900 : 0) : h >= 9 && h <= 19 ? Math.round(4000 + Math.sin(h + d) * 3000) : h > 20 ? 600 : 0)));
  const sum = (from: number) => days.slice(from).reduce((a, x) => ({ costUSD: +(a.costUSD + x.costUSD).toFixed(2), tokens: a.tokens + x.tokens }), { costUSD: 0, tokens: 0 });
  return {
    plan: { seatTier: "team_tier_1", rateLimitTier: "default_claude_max_5x" },
    limits: {
      latest: { at: now - 60_000, five: { pct: 38, resetsAt: now + 2.3 * H }, seven: { pct: 41, resetsAt: now + 3.6 * 24 * H } },
      series: Array.from({ length: 60 }, (_, i) => ({ at: now - (60 - i) * 2 * H, five: Math.round(Math.abs(Math.sin(i / 3)) * 70), seven: 20 + Math.round(i / 3) })),
    },
    totals: { today: sum(30), week: sum(26), month: sum(11), range: { costUSD: sum(0).costUSD, input: 4.1e6, output: 6.2e6, cacheRead: 2.1e9, cacheWrite: 61e6, requests: 14_200 }, cacheShare: 0.97 },
    days,
    models: [
      { model: "claude-opus-5-5", input: 3.6e6, output: 5.4e6, cacheRead: 1.9e9, cacheWrite: 52e6, requests: 12_100 },
      { model: "claude-sonnet-5-5", input: 0.5e6, output: 0.8e6, cacheRead: 0.2e9, cacheWrite: 9e6, requests: 2_100 },
    ],
    heat,
    top: {
      sessions: sessions.map((x) => ({ id: x.id, title: x.title ?? x.id, folder: x.cwd, costUSD: x.costUSD ?? 0 })).sort((a, b) => b.costUSD - a.costUSD),
      tickets: [["ACME-401", 9.3], ["ACME-418", 6.8], ["ACME-412", 4.12], ["ACME-399", 2.2]].map(([name, costUSD]) => ({ name, costUSD })),
      folders: [["~/worktrees/ACME-401/acme", 9.3], ["~/worktrees/ACME-418/acme", 6.8], ["~/acme", 3.1]].map(([name, costUSD]) => ({ name, costUSD })),
    },
    indexing: false,
    hasLimitsFile: true,
  };
}

const reviews = [
  { id: 2, repo: "acme/shop", pr: 1290, url: "https://github.com/acme/shop/pull/1290", title: "Cache product images at the edge", author: "sam", started_at: now - 0.4 * H, term_id: null, status: "done", review_url: "https://github.com/acme/shop/pull/1290#pullrequestreview-1", verdict: "Approved with comments", comments: 3 },
  { id: 1, repo: "acme/shop", pr: 1281, url: "https://github.com/acme/shop/pull/1281", title: "Wishlist sharing links", author: "ana", started_at: now - 26 * H, term_id: null, status: "done", review_url: "https://github.com/acme/shop/pull/1281#pullrequestreview-2", verdict: "Changes requested", comments: 5 },
];

// ---------- the Board, tasks and the rest of the orchestration screens ----------
const demoTasks: Task[] = [
  { id: "t-423-1", group: "g-423", title: "Spike: offline basket sync", prompt: "Try a service worker that keeps the basket in IndexedDB and syncs it when the network is back. Write up what works.", ticket: "ACME-423", attempt: 1, status: "running", dependsOn: [], worktree: wt("ACME-423"), branch: "feat/ACME-423/offline-basket", sessionId: "d10", createdAt: now - 1.2 * H, startedAt: now - 1.1 * H },
  { id: "t-423-2", group: "g-423", title: "Spike: offline basket sync", prompt: "Try a service worker that keeps the basket in IndexedDB and syncs it when the network is back. Write up what works.", ticket: "ACME-423", attempt: 2, status: "done", dependsOn: [], worktree: wt("ACME-423-2"), branch: "feat/ACME-423-2/offline-basket", sessionId: "d11", createdAt: now - 1.2 * H, startedAt: now - 1.1 * H, finishedAt: now - 0.3 * H },
  { id: "t-420-1", group: "g-420", title: "Empty state for the wishlist", prompt: "Add the empty state from the design file to the wishlist page, with a link back to the shop.", ticket: "ACME-420", attempt: 1, status: "queued", dependsOn: ["g-423"], createdAt: now - 0.5 * H },
];

function demoBoard(): BoardCard[] {
  const live = sessions.filter((x) => x.status !== "ended");
  const cards: BoardCard[] = [];
  for (const w of worktrees.filter((x) => !x.main)) {
    const { pr: p, session: ss } = matchWorker(w, prs.mine, live);
    const autopilot = w.ticket === "ACME-412" ? { on: true, attempts: 1, gaveUp: false, note: "Fixing the checks: told its session" } : undefined;
    const verify = w.ticket === "ACME-418" ? { state: "pass" as const, at: now - 0.8 * H } : undefined;
    const placed = columnOf({ session: ss, pr: p, verify, autopilot });
    cards.push({
      id: w.path,
      kind: "worktree",
      title: tickets.find((t) => t.key === w.ticket)?.summary ?? w.name,
      ticket: w.ticket,
      folder: `${w.name} · acme`,
      path: w.path,
      branch: w.branch,
      ...placed,
      session: ss && { id: ss.id, status: ss.status, updatedAt: ss.updatedAt, title: ss.title, pid: ss.pid },
      pr: p && { number: p.number, url: p.url, title: p.title, state: p.state, checks: p.checks, review: p.reviewDecision, isDraft: p.isDraft, mergeable: p.state === "OPEN" ? "MERGEABLE" : undefined },
      verify,
      autopilot,
      updatedAt: Math.max(ss?.updatedAt ?? 0, p ? Date.parse(p.mergedAt ?? p.createdAt) : 0),
    });
  }
  for (const t of demoTasks) {
    const busy = t.status === "running";
    const placed = t.status === "queued" ? { column: "queued" as const, reason: "Waiting on another task or a free slot" } : columnOf({ session: { status: busy ? "busy" : "idle", updatedAt: now }, task: t });
    cards.push({
      id: t.worktree ?? `t:${t.id}`,
      kind: t.worktree ? "worktree" : "task",
      title: t.title,
      ticket: t.ticket,
      folder: t.worktree ? `${t.worktree.split("/").slice(-2, -1)[0]} · acme` : "new worktree",
      path: t.worktree,
      branch: t.branch,
      ...placed,
      session: t.sessionId ? { id: t.sessionId, status: busy ? "busy" : "idle", updatedAt: now - (busy ? 0 : 0.3 * H) } : undefined,
      task: { id: t.id, group: t.group, status: t.status, attempt: t.attempt, title: t.title },
      updatedAt: t.createdAt,
    });
  }
  const main = live.find((x) => !x.worktree);
  if (main) {
    const stuck = "Busy for 41 minutes with nothing new in its transcript";
    cards.push({ id: `s:${main.id}`, kind: "session", title: main.title ?? "claude", folder: "acme", path: main.cwd, branch: main.branch, ...columnOf({ session: main, stuck }), session: { id: main.id, status: main.status, updatedAt: main.updatedAt, title: main.title }, stuck, updatedAt: main.updatedAt });
  }
  return cards.sort((a, b) => b.updatedAt - a.updatedAt);
}

const demoAsk = (id: string): AskInfo => {
  const s = sessions.find((x) => x.id === id);
  if (s?.status === "busy") return { reachable: true, options: [], screen: "● Reading the checkout components…\n\n✻ Working (esc to interrupt)" };
  if (id === "d2")
    return {
      reachable: true,
      screen: "● The prefix index is in. I'll run the search tests next.\n\n Bash command\n   pnpm test --filter search\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for pnpm test\n   3. No, and tell Claude what to do differently (esc)",
      question: "Do you want to proceed?",
      options: [
        { key: "1", label: "Yes" },
        { key: "2", label: "Yes, and don't ask again for pnpm test" },
        { key: "3", label: "No, and tell Claude what to do differently (esc)" },
      ],
      last: "The prefix index is in. I'll run the search tests next.",
    };
  return { reachable: true, options: [], screen: "● Apple Pay now shows on Safari and Chrome on Android. The review comment about the button size is fixed too.\n\n  Should I also hide it on desktop browsers that don't support it, or leave the fallback button?\n\n✻ Cooked for 2m 10s", last: "Should I also hide it on desktop browsers that don't support it, or leave the fallback button?" };
};

const demoGroup = (g: string) => {
  const list = demoTasks.filter((t) => t.group === g);
  if (!list.length) return undefined;
  const files = (n: number) =>
    [
      { path: "src/basket/offline.ts", added: 84 + n * 20, removed: 0, status: "A" },
      { path: "src/sw.ts", added: 41 - n * 9, removed: 3, status: "M" },
      { path: "docs/offline-basket.md", added: 36, removed: 0, status: "A" },
    ].slice(0, 2 + n);
  return {
    title: list[0].title,
    prompt: list[0].prompt,
    ticket: list[0].ticket,
    dependsOn: list[0].dependsOn,
    attempts: list.map((t, i) => ({ task: t, files: t.worktree ? files(i) : [], session: t.sessionId ? { id: t.sessionId, status: t.status === "running" ? "busy" : "idle", costUSD: 1.4 + i, linesAdded: 120 + i * 30, linesRemoved: 3, updatedAt: now - i * 0.3 * H } : undefined })),
  };
};

const demoDigest = [
  { at: now - 0.3 * H, kind: "task", title: "Task done: Spike: offline basket sync", body: "Attempt 2", link: "/tasks/g-423" },
  { at: now - 0.8 * H, kind: "notify", title: "Claude is waiting", body: "Prefix index for search", link: "/sessions/d2" },
  { at: now - 1.1 * H, kind: "autopilot", title: "Autopilot is on #1291", body: "Checks failed, so it told its session.", link: "/board" },
];

const demoTools = {
  days: 30,
  tools: [
    { name: "Read", calls: 1840, tokens: 2_400_000 },
    { name: "Bash", calls: 1210, tokens: 1_650_000 },
    { name: "Grep", calls: 960, tokens: 610_000 },
    { name: "Edit", calls: 720, tokens: 140_000 },
    { name: "WebFetch", calls: 44, tokens: 120_000 },
    { name: "Glob", calls: 310, tokens: 60_000 },
  ],
  commands: [
    { name: "pnpm test", calls: 220, tokens: 690_000 },
    { name: "git diff", calls: 160, tokens: 380_000 },
    { name: "pnpm build", calls: 90, tokens: 240_000 },
    { name: "rg", calls: 140, tokens: 120_000 },
    { name: "git log", calls: 80, tokens: 60_000 },
  ],
};

export function mountDemo(app: Hono) {
  const ok = (v: unknown) => () => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const routes: Record<string, (q: URLSearchParams) => Response> = {
    "/api/config": () => Response.json({ statusOrder: report().statusOrder, releasedStatuses: report().releasedStatuses, repoName: "acme", tracker: { plugin: "demo", name: "Jira" }, codeHost: { plugin: "demo", name: "GitHub" }, demo: true, hidden: getSettings().hidden, screens: pluginScreens(), themes: pluginThemes() }),
    "/api/sessions": ok(sessions),
    "/api/tickets": ok({ sprint, tickets: tickets.map((t) => ({ ...t, lastSession: (() => { const s = sessions.find((x) => x.ticket === t.key); return s ? { id: s.id, status: s.status, updatedAt: s.updatedAt } : null; })() })) }),
    "/api/tickets/new": ok({ types: ["Story", "Task", "Bug"], presets: ["Web", "Mobile"], fields: [{ key: "ac", label: "Acceptance criteria", kind: "lines" }, { key: "points", label: "Story points", kind: "number" }], sprint: true }),
    "/api/prs": ok(prs),
    "/api/sprints": ok([sprint]),
    "/api/worktrees": ok(worktrees),
    "/api/jobs": ok([]),
    "/api/board": () => Response.json(demoBoard()),
    "/api/badges": () => {
      const cards = demoBoard();
      const needs = cards.filter((c) => c.column === "needs").length;
      const working = cards.filter((c) => c.column === "working").length;
      return Response.json({
        "/board": { attention: needs, live: working, title: `${needs} need you · ${working} working` },
        "/runs": { live: 1, failed: 1, title: "1 run going · 1 failed since you last looked" },
        "/terminals": { count: 3, live: 1, title: "3 terminals open · Claude working in 1" },
        "/reviews": { attention: prs.review.length, title: `${prs.review.length} PR${prs.review.length === 1 ? "" : "s"} waiting for your review` },
      });
    },
    "/api/tasks": ok(demoTasks),
    "/api/digest": ok(demoDigest),
    "/api/usage/tools": ok(demoTools),
    "/api/preview": ok(null),
    "/api/code/roots": ok({ worktrees: worktrees.map((w) => ({ path: w.path, name: w.name, branch: w.branch, ticket: w.ticket })), projects: [paths.root], folders: [] }),
    "/api/usage": ok(usage()),
    "/api/reviews": ok(reviews),
    "/api/claude/workflows": ok([run]),
    "/api/claude/workflows/wf_demo": ok({ ...run, script: "export const meta = { name: 'search-speedup', phases: [...] }\n", result: { winner: "prefix-index", p95ms: 180 } }),
    "/api/claude/files": ok(files),
    "/api/claude/doctor": ok([{ level: "warn", where: "~/acme memory", message: "api-mocks.md has no line in MEMORY.md" }]),
    "/api/claude/backups": ok([]),
    "/api/report/sprint": (q) => ok(report(q.get("scope") === "me" ? "me" : "team"))(),
    "/api/report/activity": ok(activity()),
    "/api/report/saydo": (q) => {
      const me = q.get("scope") === "me";
      const r = report(me ? "me" : "team");
      return ok([
        ...[[19, 14, 12], [20, 16, 13], [21, 13, 13], [22, 18, 14], [23, 15, 12.5]].map(([n, committed, completed]) => ({ id: n, name: `Sprint ${n}`, active: false, committed: me ? committed : committed * 3, completed: me ? completed : +(completed * 2.6).toFixed(1) })),
        { id: sprint.id, name: sprint.name, active: true, committed: r.totals.scope, completed: r.totals.done },
      ])();
    },
    "/api/report/daily": () => new Response(daily),
    "/api/report/weekly": ok({ from: day(now - 6 * 24 * H), to: day(now), released: tickets.filter((t) => ["Done", "Ready to release"].includes(t.status)), prsMerged: prs.mine.filter((p) => p.mergedAt), prsOpened: [], commits: 38, costUSD: 44.6, sessions: 12 }),
    "/api/report/day": ok({ date: day(now), sessions: sessions.filter((s) => s.status !== "ended"), commits: [1.5, 2.6, 4.1].map((h, i) => ({ sha: `c${i}`, subject: "feat: saved cards", at: iso(now - h * H) })), costUSD: 13.28, transitions: [], prsOpened: [], prsMerged: [] }),
  };

  app.use("/api/*", async (c, next) => {
    const p = c.req.path;
    if (c.req.method === "GET" && routes[p]) return routes[p](new URL(c.req.url).searchParams);
    const sm = p.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    if (sm && c.req.method === "GET") {
      const s = sessions.find((x) => x.id === sm[1]);
      if (!sm[2]) return c.json(s ?? sessions[0]);
      if (sm[2] === "/agents") return c.json([]);
      if (sm[2] === "/ask") return c.json(demoAsk(sm[1]));
      if (sm[2] === "/entries") return c.json({ entries: withIds(script, 0), offset: 0, truncated: false });
    }
    const gm = p.match(/^\/api\/tasks\/group\/([^/]+)$/);
    if (gm && c.req.method === "GET") {
      const g = demoGroup(gm[1]);
      return g ? c.json(g) : c.notFound();
    }
    if (/^\/api\/sessions\/[^/]+\/(send|keys)$/.test(p) && c.req.method === "POST") return c.json({ sent: true });
    const tm = p.match(/^\/api\/tickets\/([A-Z]+-\d+)$/);
    if (tm && c.req.method === "GET") {
      const t = tickets.find((x) => x.key === tm[1]) ?? tickets[0];
      return c.json({
        ...t,
        description: "As a returning customer I want to pick a saved card at checkout so I don't type my card details every time.",
        comments: [{ author: "Sam", created: iso(now - 20 * H), body: "Design is in the checkout file, page 3." }],
        prs: prs.mine.filter((x) => x.ticket === t.key),
        worktrees: worktrees.filter((w) => w.ticket === t.key),
        sessions: sessions.filter((s) => s.ticket === t.key),
      });
    }
    if (p === "/api/claude/file" && c.req.method === "GET") return c.json({ content: fileText[c.req.query("path") ?? ""] ?? "# Notes\n", mtime: now });
    // anything else that writes or shells out is a no-op in the demo
    if (c.req.method !== "GET" && !p.startsWith("/api/code/")) return c.json({ ok: true, id: "demo" });
    return next();
  });

  // keep the strip alive: flip the second session between working and waiting
  let tick = 0;
  setInterval(() => {
    tick++;
    const list = sessions.filter((s) => s.status !== "ended").map((s, i) => (i === 1 ? { ...s, status: (tick % 4 < 2 ? "busy" : "idle") as Session["status"], updatedAt: Date.now() } : s));
    broadcast({ type: "sessions", sessions: list });
  }, 4000);
}

export const demoSessions = () => sessions.filter((s) => s.status !== "ended");
