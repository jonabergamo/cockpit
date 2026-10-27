import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ConfigFile, DoctorIssue, Memory } from "@cockpit/shared";
import { config, paths } from "../config.ts";
import { db } from "../db.ts";
import { slugify } from "../util.ts";
import { projectsDir } from "./sessions.ts";

const home = config.claude.dir;
const backupsDir = join(paths.data, "backups");

async function ls(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function entry(path: string, label: string, group: ConfigFile["group"], project?: string): Promise<ConfigFile | undefined> {
  const s = await stat(path).catch(() => undefined);
  if (!s?.isFile()) return;
  return { path, label, group, project, mtime: s.mtimeMs, size: s.size };
}

// The project dir name is the cwd with every non-alnum char turned into "-", which can't be reversed,
// so take the real cwd from a session that ran there.
function projectLabel(dir: string) {
  const row = db.prepare<[string], { cwd: string }>("select cwd from sessions where project = ? and cwd is not null limit 1").get(dir);
  return row?.cwd?.replace(process.env.HOME ?? "", "~") ?? dir;
}

const repos = async () => {
  const out = [config.repo.path].filter(Boolean);
  for (const base of config.extraRoots) for (const d of await ls(base)) if (d.isDirectory()) out.push(join(base, d.name));
  return out;
};

export async function listFiles() {
  const out: (ConfigFile | undefined)[] = [];
  out.push(await entry(join(home, "CLAUDE.md"), "CLAUDE.md", "global"));
  out.push(await entry(join(home, "settings.json"), "settings.json", "settings"));
  out.push(await entry(join(home, "statusline.sh"), "statusline.sh", "global"));

  for (const d of await ls(join(home, "skills"))) {
    if (!d.isDirectory() || d.name === "synced" || d.name.startsWith(".")) continue;
    const dir = join(home, "skills", d.name);
    out.push(await entry(join(dir, "SKILL.md"), d.name, "skill"));
    for (const r of await ls(join(dir, "references"))) if (r.isFile()) out.push(await entry(join(dir, "references", r.name), `${d.name}/${r.name}`, "skill"));
  }

  for (const d of await ls(join(home, "agents"))) if (d.name.endsWith(".md")) out.push(await entry(join(home, "agents", d.name), d.name, "global"));
  for (const d of await ls(join(home, "plans"))) if (d.name.endsWith(".md")) out.push(await entry(join(home, "plans", d.name), d.name, "plan"));
  for (const d of await ls(join(home, "workflows"))) if (d.name.endsWith(".js")) out.push(await entry(join(home, "workflows", d.name), d.name, "workflow"));

  for (const p of await ls(projectsDir)) {
    const memDir = join(projectsDir, p.name, "memory");
    if (!existsSync(memDir)) continue;
    const label = projectLabel(p.name);
    for (const f of await ls(memDir)) if (f.name.endsWith(".md")) out.push(await entry(join(memDir, f.name), f.name, "memory", label));
  }

  for (const r of await repos()) {
    const name = r.replace(process.env.HOME ?? "", "~");
    out.push(await entry(join(r, "CLAUDE.md"), "CLAUDE.md", "project", name));
    out.push(await entry(join(r, ".claude/settings.json"), "settings.json", "project", name));
    out.push(await entry(join(r, ".claude/settings.local.json"), "settings.local.json", "project", name));
    for (const d of await ls(join(r, ".claude/workflows"))) if (d.name.endsWith(".js")) out.push(await entry(join(r, ".claude/workflows", d.name), d.name, "workflow", name));
  }

  return out.filter((f): f is ConfigFile => !!f);
}

// Writes are limited to these places, never credentials or session keys.
async function writable(path: string) {
  const p = resolve(path);
  if (/\.credentials\.json$|\/sessions\//.test(p)) return false;
  const roots = [home, ...(await repos()).map((r) => join(r, ".claude")), ...(await repos()).map((r) => join(r, "CLAUDE.md"))];
  return roots.some((r) => p === r || !relative(r, p).startsWith(".."));
}

export function frontmatter(text: string) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return;
  const out: Record<string, string> = {};
  let parent = "";
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    if (!kv[1]) parent = kv[2];
    const key = kv[1] ? `${parent}.${kv[2]}` : kv[2];
    out[key] = kv[3].replace(/^["']|["']$/g, "");
  }
  return out;
}

function validate(path: string, content: string) {
  if (path.endsWith(".json")) JSON.parse(content);
  if (path.includes("/memory/") && basename(path) !== "MEMORY.md") {
    const fm = frontmatter(content);
    if (!fm?.name || !fm?.description) throw new Error("memory needs frontmatter with name and description");
  }
  if (basename(path) === "SKILL.md") {
    const fm = frontmatter(content);
    if (!fm?.name || !fm?.description) throw new Error("SKILL.md needs frontmatter with name and description");
  }
}

const backupName = (path: string) => relative("/", path).replace(/\//g, "__");

async function backup(path: string) {
  if (!existsSync(path)) return;
  await mkdir(backupsDir, { recursive: true });
  await copyFile(path, join(backupsDir, `${Date.now()}--${backupName(path)}`));
}

export async function readConfig(path: string) {
  if (!(await writable(path))) throw new Error("path not allowed");
  const s = await stat(path);
  return { path, content: await readFile(path, "utf8"), mtime: s.mtimeMs };
}

export async function writeConfig(path: string, content: string, expectMtime?: number) {
  if (!(await writable(path))) throw new Error("path not allowed");
  validate(path, content);
  if (expectMtime && existsSync(path) && Math.abs((await stat(path)).mtimeMs - expectMtime) > 1) {
    throw new Error("file changed on disk since you opened it");
  }
  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return (await stat(path)).mtimeMs;
}

export async function backups(path: string) {
  const suffix = `--${backupName(path)}`;
  return (await ls(backupsDir))
    .filter((d) => d.name.endsWith(suffix))
    .map((d) => ({ file: d.name, at: Number(d.name.split("--")[0]) }))
    .sort((a, b) => b.at - a.at);
}

export const readBackup = (file: string) => readFile(join(backupsDir, basename(file)), "utf8");

export async function memories(memDir: string): Promise<Memory[]> {
  const index = await readFile(join(memDir, "MEMORY.md"), "utf8").catch(() => "");
  const out: Memory[] = [];
  for (const f of await ls(memDir)) {
    if (!f.name.endsWith(".md") || f.name === "MEMORY.md") continue;
    const fm = frontmatter(await readFile(join(memDir, f.name), "utf8")) ?? {};
    out.push({
      file: f.name,
      name: fm.name ?? f.name,
      description: fm.description ?? "",
      type: fm["metadata.type"] ?? fm.type ?? "",
      indexed: index.includes(`(${f.name})`),
    });
  }
  return out;
}

export async function createMemory(memDir: string, m: { name: string; description: string; type: string; body: string; title?: string }) {
  if (!memDir.startsWith(projectsDir) || basename(memDir) !== "memory") throw new Error("not a memory dir");
  const slug = slugify(m.name, 60);
  const file = join(memDir, `${slug}.md`);
  if (existsSync(file)) throw new Error(`${slug}.md already exists`);

  const text = `---\nname: ${slug}\ndescription: ${m.description}\nmetadata:\n  type: ${m.type}\n---\n\n${m.body.trim()}\n`;
  await writeConfig(file, text);

  const indexPath = join(memDir, "MEMORY.md");
  const index = await readFile(indexPath, "utf8").catch(() => "");
  const line = `- [${m.title ?? m.name}](${slug}.md) — ${m.description}`;
  await writeConfig(indexPath, index.trimEnd() + (index.trim() ? "\n" : "") + line + "\n");
  return file;
}

export async function doctor(): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];

  const settings = join(home, "settings.json");
  try {
    const s = JSON.parse(await readFile(settings, "utf8"));
    for (const [event, groups] of Object.entries<any[]>(s.hooks ?? {})) {
      for (const g of groups) {
        for (const h of g.hooks ?? []) {
          const bin = String(h.command ?? "").trim().split(/\s+/)[0];
          if (bin.startsWith("/") && !existsSync(bin)) issues.push({ level: "error", where: `settings.json hooks.${event}`, message: `script not found: ${bin}` });
        }
      }
    }
  } catch (e) {
    // none at all is fine: Claude Code isn't set up here, or never changed a setting
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ level: "error", where: "settings.json", message: `can't parse: ${(e as Error).message}` });
  }

  for (const p of await ls(projectsDir)) {
    const memDir = join(projectsDir, p.name, "memory");
    if (!existsSync(memDir)) continue;
    const label = projectLabel(p.name);
    const index = await readFile(join(memDir, "MEMORY.md"), "utf8").catch(() => "");
    for (const m of index.matchAll(/\]\(([^)]+\.md)\)/g)) {
      if (!existsSync(join(memDir, m[1]))) issues.push({ level: "warn", where: `${label} memory`, message: `MEMORY.md links to missing ${m[1]}` });
    }
    for (const m of await memories(memDir)) {
      if (!m.indexed) issues.push({ level: "warn", where: `${label} memory`, message: `${m.file} has no line in MEMORY.md` });
      if (!m.description) issues.push({ level: "warn", where: `${label} memory`, message: `${m.file} has no description` });
    }
  }

  for (const d of await ls(join(home, "skills"))) {
    if (!d.isDirectory() || d.name === "synced" || d.name.startsWith(".")) continue;
    const file = join(home, "skills", d.name, "SKILL.md");
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) issues.push({ level: "warn", where: `skill ${d.name}`, message: "no SKILL.md" });
    else if (!frontmatter(text)?.description) issues.push({ level: "warn", where: `skill ${d.name}`, message: "SKILL.md has no description" });
  }

  const claudeMd = await stat(join(home, "CLAUDE.md")).catch(() => undefined);
  if (claudeMd && claudeMd.size > 40_000) issues.push({ level: "warn", where: "CLAUDE.md", message: `${Math.round(claudeMd.size / 1000)} KB, it loads into every session` });

  return issues;
}
