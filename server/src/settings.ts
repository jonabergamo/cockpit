import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { config, demo } from "./config.ts";
import { db } from "./db.ts";

// Preferences set from the Settings page, kept in sqlite so every device sees the same ones.
// config.toml stays for what the server needs to start; these are about what the app shows.
db.exec("create table if not exists settings (key text primary key, value text not null)");

const schema = z.object({
  // auto works out from the Claude login whether the dollars are a bill or only what the tokens would cost on the API
  costs: z.enum(["auto", "real", "api", "hide"]).default("auto"),
  // screens taken out of the nav, by route ("/reviews") or plugin screen ("plugin:<id>/<screen>")
  hidden: z.array(z.string()).default([]),
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
  // the instructions for the sprint report's additional notes; empty uses the built-in ones
  // liveBranch: the branch that is production, so the notes can tell shipped work from work still on its way
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
export const writeRow = (key: string, value: unknown) => db.prepare("insert or replace into settings (key, value) values (?, ?)").run(key, JSON.stringify(value));

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
