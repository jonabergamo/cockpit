import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

const root = resolve(import.meta.dirname, "../..");

const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
const path = z.string().transform(expand);

const schema = z.object({
  port: z.number().default(8770),
  host: z.string().default("127.0.0.1"),
  // older setups kept the Tailscale login here; it's read once into the tailscale plugin's settings
  allowedLogin: z.string().default(""),
  // Folders whose git repos can also be opened in the code view, besides the worktrees
  extraRoots: z.array(path).default([]),
  // where your own plugins live, besides the ones that ship in plugins/; empty means <data>/plugins
  pluginsDir: path.default(""),
  claude: z.object({ dir: path.default("~/.claude") }).prefault({}),
  repo: z
    .object({
      path: path.default(""),
      name: z.string().default(""),
      worktreesDir: path.default("~/.claude/worktrees"),
      keyPattern: z.string().default("[A-Z][A-Z0-9]+-\\d+"),
      branchTemplate: z.string().default("feat/{key}/{slug}"),
      createCommand: z.string().default("git -C {repo} worktree add -b {branch} {worktreesDir}/{key}/{name} origin/main"),
      deleteCommand: z.string().default("git -C {repo} worktree remove {path}"),
      openCommand: z.string().default("code {path}"),
    })
    .prefault({}),
  jira: z
    .object({
      enabled: z.boolean().default(false),
      board: z.string().default(""),
      assignee: z.string().default(""),
      pointsField: z.string().default("customfield_10016"),
      releasedStatuses: z.array(z.string()).default(["Done"]),
      // what counts as done for the burndown and say/do, often wider than released (testing still to come)
      doneStatuses: z.array(z.string()).default([]),
      // groups for the status chart, in order; statuses left out go by their Jira category
      buckets: z.record(z.string(), z.array(z.string())).default({}),
      statusOrder: z.array(z.string()).default(["To Do", "In Progress", "Review", "QA", "Done"]),
    })
    .prefault({}),
  github: z
    .object({
      enabled: z.boolean().default(false),
      repo: z.string().default(""),
    })
    .prefault({}),
  report: z.object({ snapshotMinutes: z.number().default(60) }).prefault({}),
  reviews: z
    .object({
      // first prompt of the Claude session that reviews a PR, {url} is the PR link
      // the cockpit-pr-review skill ships with the GitHub plugin and prints the link and verdict the screen reads
      command: z.string().default("/cockpit-pr-review {url}"),
      backendNote: z.string().default(" Include the backend too."),
      cwd: path.default(""),
    })
    .prefault({}),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const file = process.env.COCKPIT_CONFIG ?? join(root, "config.local.toml");
  const raw = existsSync(file) ? parse(readFileSync(file, "utf8")) : {};
  const cfg = schema.parse(raw);
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (!cfg.repo.name && cfg.repo.path) cfg.repo.name = cfg.repo.path.split("/").pop()!;
  return cfg;
}

export const config = load();
export const paths = {
  root,
  data: process.env.COCKPIT_DATA ?? join(root, "data"),
  web: join(root, "web/dist"),
};
export const demo = process.env.COCKPIT_DEMO === "1";
