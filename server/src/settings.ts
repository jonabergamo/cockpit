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
