import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { config, demo } from "./config.ts";
import { db } from "./db.ts";

// Preferences set from the Settings page, kept in sqlite so every device sees the same ones.
// config.toml stays for what the server needs to start; these are about what the app shows.
db.exec("create table if not exists settings (key text primary key, value text not null)");

const isRegex = (s: string) => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
};

const schema = z.object({
  // auto works out from the Claude login whether the dollars are a bill or only what the tokens would cost on the API
  costs: z.enum(["auto", "real", "api", "hide"]).default("auto"),
  // screens taken out of the nav, by route ("/reviews") or plugin screen ("plugin:<id>/<screen>"). The screens that
  // became tabs keep their route as the tab's id ("/usage"); Code and Memory start out of the sidebar
  hidden: z.array(z.string()).default(["/code", "/memory"]),
  // which plugin provides these when more than one can; empty takes the first that's on
  tracker: z.string().default(""),
  codeHost: z.string().default(""),
  // font family names from the device; empty keeps the ones cockpit ships
  fonts: z
    .object({
      ui: z.string().max(120).default(""),
      code: z.string().max(120).default(""),
      codeSize: z.number().int().min(9).max(24).default(13),
    })
    .default({ ui: "", code: "", codeSize: 13 }),
  // what the Board does on its own
  autopilot: z
    .object({
      // how many times it hands the same PR back to Claude before it stops and asks you
      maxAttempts: z.number().int().min(1).max(10).default(3),
      // new worktrees start with autopilot on
      onByDefault: z.boolean().default(false),
    })
    .prefault({}),
  tasks: z
    .object({
      maxParallel: z.number().int().min(1).max(12).default(3),
      // queued tasks wait while the 5 hour limit is above this
      pauseAbovePct: z.number().int().min(10).max(100).default(85),
      defaultModel: z.string().max(60).default(""),
    })
    .prefault({}),
  verify: z.object({ auto: z.boolean().default(true) }).prefault({}),
  alerts: z
    .object({
      // busy this long without the transcript growing counts as stuck
      stuckMinutes: z.number().int().min(5).max(240).default(20),
      // waiting this long sends a second, urgent notification
      escalateMinutes: z.number().int().min(0).max(240).default(15),
    })
    .prefault({}),
  away: z.object({ minutes: z.number().int().min(5).max(24 * 60).default(30) }).prefault({}),
  // the weekly digest's notification: on this day (0 is Sunday) from this hour
  weekly: z.object({ on: z.boolean().default(true), day: z.number().int().min(0).max(6).default(5), hour: z.number().int().min(0).max(23).default(16) }).prefault({}),
  // kinds of work, see templates.ts; the first whose pattern matches a ticket is used
  templates: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        name: z.string().min(1).max(60),
        match: z.string().max(300).default(""),
        vars: z.record(z.string().regex(/^\w+$/), z.string().max(300)).default({}),
        model: z.string().max(60).default(""),
        prompt: z.string().max(4000).default(""),
        autopilot: z.enum(["default", "on", "off"]).default("default"),
      }),
    )
    .max(30)
    .default([]),
  // what a ticket's sessions may use before cockpit says so, in dollars or, with costs hidden, millions of tokens.
  // 0 is no budget. Tickets can set their own.
  budget: z
    .object({
      perTicketUSD: z.number().min(0).max(100_000).default(0),
      perTicketMTokens: z.number().min(0).max(100_000).default(0),
      warnPct: z.number().int().min(10).max(100).default(80),
    })
    .prefault({}),
  // which commands count as which kind of run, as regular expressions over the command (quoted text left out).
  // Checked in this order; an empty one turns that kind off.
  runs: z
    .object({
      patterns: z
        .object({
          e2e: z.string().max(400).refine(isRegex, "not a valid regular expression").default(String.raw`\b(maestro|playwright test|cypress run|detox test)\b|\b(pnpm|npm|yarn|bun)\b[^|;&]*\be2e(:\S+)?\b`),
          audit: z.string().max(400).refine(isRegex, "not a valid regular expression").default(String.raw`\b(pnpm|npm|yarn|bun)\b[^|;&]*\baudit\b|\b(pip-audit|cargo audit)\b`),
          typecheck: z.string().max(400).refine(isRegex, "not a valid regular expression").default(String.raw`\b(tsc|mypy|pyright)\b|\b(pnpm|npm|yarn|bun)\b[^|;&]*\b(typecheck|type-check|tsc)\b`),
          lint: z.string().max(400).refine(isRegex, "not a valid regular expression").default(String.raw`\b(eslint|prettier|biome|ruff|flake8)\b|\b(pnpm|npm|yarn|bun)\b[^|;&]*\b(lint|fix:all|format)(:\S+)?\b`),
          unit: z.string().max(400).refine(isRegex, "not a valid regular expression").default(String.raw`\b(jest|vitest|pytest|go test|cargo test)\b|\b(pnpm|npm|yarn|bun)\b[^|;&]*\btest(:\S+)?\b`),
        })
        .prefault({}),
      // how long a failed or cancelled run keeps its video; 0 keeps them
      failedVideoHours: z.number().int().min(0).max(2160).default(24),
      // the "recorded by cockpit" line at the foot of a ticket's image of checks
      imageCredit: z.boolean().default(true),
    })
    .prefault({}),
  // the overnight queue: tasks marked for it wait until you're away (the button, or these hours; -1 is the button
  // only) and stop once the night has used its cap, in dollars or, with costs hidden, millions of tokens
  overnight: z
    .object({
      capUSD: z.number().min(0).max(10_000).default(10),
      capMTokens: z.number().min(0).max(100_000).default(20),
      fromHour: z.number().int().min(-1).max(23).default(-1),
      toHour: z.number().int().min(0).max(23).default(8),
    })
    .prefault({}),
  // which command runs a CI check here, one "check name = command" per line (* matches anything in the name);
  // a check with none runs the package.json script of the same name, else repo.verifyCommand
  ci: z.object({ local: z.array(z.string().max(400)).max(40).default([]) }).prefault({}),
  // the instructions for the sprint report's additional notes; empty uses the built-in ones
  // liveBranch: the branch that is production, so the notes can tell shipped work from work still on its way
  // where each kind of work runs when there are other machines: "auto", "here" (this machine) or a machine's id
  machines: z
    .object({
      placement: z
        .object({
          automations: z.string().max(40).default("auto"),
          headless: z.string().max(40).default("auto"),
          whisper: z.string().max(40).default("auto"),
        })
        .prefault({}),
    })
    .prefault({}),
  notes: z
    .object({ prompt: z.string().max(8000).default(""), maxChars: z.number().int().min(0).max(20000).default(0), liveBranch: z.string().max(100).default("") })
    .prefault({}),
});
export type Settings = z.infer<typeof schema>;

// Rows outside the schema, like the plugins' on/off state and settings
export function readRow<T>(key: string): T | undefined {
  const row = db.prepare("select value from settings where key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}
export const writeRow = (key: string, value: unknown) => {
  const r = db.prepare("insert or replace into settings (key, value) values (?, ?)").run(key, JSON.stringify(value));
  if (key === "plugins") changed();
  return r;
};

// the settings and plugins' set up changed, which a hub passes on to its nodes
const watchers = new Set<() => void>();
export const onSettingsChanged = (fn: () => void) => (watchers.add(fn), () => void watchers.delete(fn));
const changed = () => {
  for (const fn of watchers) fn();
};

// Once, for settings saved before the sidebar went from 13 core screens to 8. Worktrees, Workflows, Your week and
// Usage became tabs and keep their ids, so a hidden one now hides its tab. "/report" was the Sprint report and is now
// the Reports screen, so it becomes the Sprint tab, unless the week and usage were hidden too and nothing of it showed.
// Tasks is a filter on Work that can't be hidden, and Code and Memory leave the sidebar as they do for new installs.
export function moveHidden() {
  if (readRow<number>("navVersion") === 2) return;
  const hidden = readRow<string[]>("hidden");
  if (Array.isArray(hidden)) {
    const all = hidden.includes("/weekly") && hidden.includes("/usage");
    const next = hidden.filter((h) => h !== "/tasks").map((h) => (h === "/report" && !all ? "/report#sprint" : h));
    for (const id of ["/code", "/memory"]) if (!next.includes(id)) next.push(id);
    writeRow("hidden", next);
  }
  writeRow("navVersion", 2);
}
moveHidden();

export function getSettings(): Settings {
  const rows = db.prepare("select key, value from settings").all() as { key: string; value: string }[];
  const raw = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : schema.parse({});
}

export function putSettings(patch: unknown) {
  const next = schema.parse({ ...getSettings(), ...(patch as object) });
  const put = db.prepare("insert or replace into settings (key, value) values (?, ?)");
  for (const [k, v] of Object.entries(next)) put.run(k, JSON.stringify(v));
  changed();
  return next;
}

export type Billing = { kind: "subscription" | "api" | "unknown"; why: string };

const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8").catch(() => "{}"));

// Claude Code writes a dollar total into every transcript, priced at API rates whatever the login.
// It is a real bill only when Claude runs on an API key or a cloud provider; on a Pro/Max/Team/Enterprise plan it is just a comparison.
export async function detectBilling(): Promise<Billing> {
  if (demo) return { kind: "subscription", why: "you're logged in with a Claude plan" };
  const settings = await readJson(join(config.claude.dir, "settings.json"));
  const env = { ...settings.env, ...process.env };
  if (env.CLAUDE_CODE_USE_BEDROCK === "1") return { kind: "api", why: "Claude runs on Amazon Bedrock" };
  if (env.CLAUDE_CODE_USE_VERTEX === "1") return { kind: "api", why: "Claude runs on Google Vertex AI" };
  if (env.CLAUDE_CODE_USE_FOUNDRY === "1") return { kind: "api", why: "Claude runs on Microsoft Foundry" };
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || settings.apiKeyHelper) return { kind: "api", why: "Claude uses an API key" };

  const account = (await readJson(join(homedir(), ".claude.json"))).oauthAccount;
  if (!account) return { kind: "unknown", why: "no Claude login found on this machine" };
  const plan = [account.billingType, account.seatTier, account.userRateLimitTier, account.subscriptionType].filter(Boolean).join(" ");
  if (/subscription|max|pro|team|enterprise|seat/i.test(plan)) return { kind: "subscription", why: "you're logged in with a Claude plan" };
  return { kind: "api", why: "you're logged in with a Console account, billed per token" };
}
