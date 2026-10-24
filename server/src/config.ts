import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

const root = resolve(import.meta.dirname, "../..");

const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
const path = z.string().transform(expand);

const schema = z.object({
  // all: everything on this machine (the default). hub: the screens, settings and plugins, working with nodes.
  // node: terminals, Claude sessions, the repo and automations, for a hub on another machine to use
  role: z.enum(["all", "hub", "node"]).default("all"),
  // where a node waits for its hub: tailscale listens on loopback and this machine's Tailscale address, all on
  // every address, or give one address
  node: z.object({ port: z.number().default(8771), listen: z.string().default("tailscale") }).prefault({}),
  port: z.number().default(8770),
  host: z.string().default("127.0.0.1"),
  // older setups kept the Tailscale login here; it's read once into the tailscale plugin's settings
  allowedLogin: z.string().default(""),
  // Folders whose git repos can also be opened in the code view, besides the worktrees
  extraRoots: z.array(path).default([]),
  // where your own plugins live, besides the ones that ship in plugins/; empty means <data>/plugins
  pluginsDir: path.default(""),
  // bin is the claude that claude -p runs (notes, asking cockpit), when it isn't the one on the PATH
  claude: z.object({ dir: path.default("~/.claude"), bin: z.string().default("claude") }).prefault({}),
  // `cockpit run --record`: the virtual screen the command's browser opens on, and the Chromium that shows its
  // output beside it; empty finds one (on the PATH, or the one Playwright installed)
  record: z.object({ screen: z.string().regex(/^\d{3,4}x\d{3,4}$/).default("1600x1000"), browser: z.string().default("") }).prefault({}),
  repo: z
    .object({
      path: path.default(""),
      name: z.string().default(""),
      worktreesDir: path.default("~/.claude/worktrees"),
      keyPattern: z.string().default("[A-Z][A-Z0-9]+-\\d+"),
      branchTemplate: z.string().default("feat/{key}/{slug}"),
      // the branch work starts from and its PRs go back to, like main or staging; {base} in createCommand
      baseBranch: z.string().default("main"),
      createCommand: z.string().default("git -C {repo} worktree add -b {branch} {worktreesDir}/{key}/{name} origin/{base}"),
      deleteCommand: z.string().default("git -C {repo} worktree remove {path}"),
      openCommand: z.string().default("code {path}"),
      // a worktree on a node, opened from here in an editor that works over ssh; {host} is the node's address
      openRemoteCommand: z.string().default("code --remote ssh-remote+{host} {path}"),
      // run in a worktree when its session finishes, e.g. "pnpm lint && pnpm test"; empty skips the check
      verifyCommand: z.string().default(""),
      // starts the app for a preview; {port} is a free port cockpit picks
      devCommand: z.string().default(""),
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
      // added to the prompt when "Include the backend" is ticked. Only a review skill that knows the option needs it,
      // so the checkbox shows only when this is set
      backendNote: z.string().default(""),
      cwd: path.default(""),
    })
    .prefault({}),
});

export type Config = z.infer<typeof schema>;

export const configFile = process.env.COCKPIT_CONFIG ?? join(root, "config.local.toml");

function load(): Config {
  const file = configFile;
  const raw = existsSync(file) ? parse(readFileSync(file, "utf8")) : {};
  const cfg = schema.parse(raw);
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.COCKPIT_ROLE) cfg.role = z.enum(["all", "hub", "node"]).parse(process.env.COCKPIT_ROLE);
  if (process.env.COCKPIT_NODE_PORT) cfg.node.port = Number(process.env.COCKPIT_NODE_PORT);
  if (process.env.COCKPIT_NODE_LISTEN) cfg.node.listen = process.env.COCKPIT_NODE_LISTEN;
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
