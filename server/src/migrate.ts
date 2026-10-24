// Moving from one machine doing everything (role all) to a hub and a node, run from bin/cockpit:
//
//   cockpit migrate export [file]   on the machine you have now: what the hub keeps, in one archive
//   cockpit migrate import <file>   on the new hub: puts it in place, as a hub
//   cockpit node --adopt            on the machine you have now: it becomes the node, keeping the rest
//
// The hub keeps the settings, plugins and their data, the sprint history, reviews and the "while you were away"
// log. What a node owns (its Claude sessions and their index, usage, tasks, runs, automations, its folders)
// stays out of the archive, since it describes that machine and the node goes on keeping it.
import Database from "better-sqlite3";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { config, configFile, paths } from "./config.ts";
import { run } from "./util.ts";

// as plugins.ts has it, without loading cockpit (which would open a database where import wants none yet)
const userDir = config.pluginsDir || join(paths.data, "plugins");

// tables that describe the machine the work happens on, which a hub doesn't take
export const NODE_TABLES = ["sessions", "session_days", "session_text", "search_files", "usage", "files", "rate_limits", "tool_usage", "tool_files", "tasks", "agent_sessions", "autopilot", "verify", "runs", "stacked", "ci_compare", "links", "folders", "outbox", "cache"];
// settings rows about this machine's folders and its own hub
const nodeRow = (key: string) => /^(lead|preview|worktree-template|outbox):/.test(key) || key === "hubSettingsVersion";

// role = "x" as the file's first line, replacing one it already has
export function withRole(toml: string, role: "all" | "hub" | "node") {
  const line = `role = "${role}"`;
  return /^role\s*=.*$/m.test(toml) ? toml.replace(/^role\s*=.*$/m, line) : `${line}\n${toml}`;
}

// the hub's part of a database, in a copy: node tables emptied, node rows gone
export function hubOnly(file: string) {
  const db = new Database(file);
  const have = new Set(db.prepare<[], { name: string }>("select name from sqlite_master where type = 'table'").all().map((t) => t.name));
  db.transaction(() => {
    for (const t of NODE_TABLES) if (have.has(t)) db.exec(`delete from "${t}"`);
    for (const { key } of db.prepare<[], { key: string }>("select key from settings").all()) if (nodeRow(key)) db.prepare("delete from settings where key = ?").run(key);
  })();
  db.exec("vacuum");
  db.close();
}

async function exportHub(out = `cockpit-hub-${new Date().toISOString().slice(0, 10)}.tar.gz`) {
  const work = mkdtempSync(join(tmpdir(), "cockpit-export-"));
  try {
    // a consistent copy while the server keeps running
    const live = new Database(join(paths.data, "cockpit.db"), { readonly: true });
    live.exec(`vacuum into '${join(work, "cockpit.db").replace(/'/g, "''")}'`);
    live.close();
    hubOnly(join(work, "cockpit.db"));
    // your plugins and what they keep (recordings, notes...), but not the ones you removed
    if (existsSync(userDir)) cpSync(userDir, join(work, "plugins"), { recursive: true, filter: (src) => !src.includes(`${userDir}/.removed`) });
    writeFileSync(join(work, "config.hub.toml"), withRole(existsSync(configFile) ? readFileSync(configFile, "utf8") : "", "hub"));
    await run("tar", ["-czf", resolve(out), "-C", work, "."], { timeout: 600_000 });
    console.log(`Wrote ${resolve(out)}.

On the new hub (from a checkout of cockpit, after pnpm install):
  cockpit migrate import ${out.split("/").pop()}
  cockpit service install

Then on this machine:
  cockpit node --adopt
  cockpit service install
and pair them: Settings → Machines on the hub, Add machine, and run the command it shows here.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function importHub(file: string, force: boolean) {
  if (!file || !existsSync(file)) throw new Error("usage: cockpit migrate import <file> [--force]");
  const db = join(paths.data, "cockpit.db");
  if (existsSync(db) && !force) throw new Error(`${db} exists already. Stop cockpit here and add --force to put it aside (it's kept as cockpit.db.before-import).`);
  const work = mkdtempSync(join(tmpdir(), "cockpit-import-"));
  try {
    await run("tar", ["-xzf", resolve(file), "-C", work], { timeout: 600_000 });
    if (!existsSync(join(work, "cockpit.db"))) throw new Error("That isn't an export from cockpit migrate export");
    mkdirSync(paths.data, { recursive: true });
    for (const ext of ["", "-wal", "-shm"]) if (existsSync(db + ext)) renameSync(db + ext, `${db}.before-import${ext}`);
    cpSync(join(work, "cockpit.db"), db);
    if (existsSync(join(work, "plugins"))) cpSync(join(work, "plugins"), userDir, { recursive: true });
    const cfg = readFileSync(join(work, "config.hub.toml"), "utf8");
    // a config here already wins; the exported one is left next to it to take from
    if (existsSync(configFile)) {
      writeFileSync(`${configFile}.from-export`, cfg);
      writeFileSync(configFile, withRole(readFileSync(configFile, "utf8"), "hub"));
      console.log(`Kept your ${configFile}, set to role hub. The old machine's is in ${configFile}.from-export, for its repo and plugin paths.`);
    } else writeFileSync(configFile, cfg);
    console.log(`Imported. Check the paths in ${configFile} (repo, extraRoots) for this machine, then: cockpit service install`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// this machine goes on as a node: same data, its hub's part now shown by the hub
function adopt() {
  const before = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  writeFileSync(configFile, withRole(before, "node"));
  console.log(`Set role = "node" in ${configFile}. Restart it as a node with: cockpit service install`);
}

const [cmd, ...args] = process.argv.slice(2);
const steps: Record<string, () => Promise<void> | void> = {
  export: () => exportHub(args[0]),
  import: () => importHub(args.find((a) => !a.startsWith("--")) ?? "", args.includes("--force")),
  adopt,
};
if (process.argv[1]?.endsWith("migrate.ts")) {
  const step = steps[cmd];
  if (!step) {
    console.error("usage: cockpit migrate export [file] | cockpit migrate import <file> [--force]");
    process.exit(2);
  }
  Promise.resolve(step()).then(
    () => process.exit(0),
    (e) => (console.error((e as Error).message), process.exit(1)),
  );
}
