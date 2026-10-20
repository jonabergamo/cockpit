import type { Requirement, SettingSpec, SettingValue } from "@cockpit/shared";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { frontmatter, writeConfig } from "./claude/memory.ts";
import { config, paths } from "./config.ts";
import { startJob } from "./jobs.ts";
import { activeCodeHost, pluginRequirements } from "./plugins.ts";
import { spawnTerm } from "./pty.ts";
import { detectBilling } from "./settings.ts";
import { run } from "./util.ts";

// What cockpit needs on the machine to work, plus what each plugin that's on asks for. Settings → Setup shows
// them with a live check, an install button where that's safe, a log-in terminal and any token fields.
const core: Requirement[] = [
  {
    id: "claude",
    name: "Claude Code",
    check: ["claude", "--version"],
    login: ["claude"],
    install: { linux: "curl -fsSL https://claude.ai/install.sh | bash", darwin: "curl -fsSL https://claude.ai/install.sh | bash" },
    docs: "https://docs.anthropic.com/en/docs/claude-code",
  },
  { id: "git", name: "git", check: ["git", "--version"], install: { linux: "sudo apt install git", darwin: "xcode-select --install" }, docs: "https://git-scm.com/downloads" },
  {
    id: "tmux",
    name: "tmux",
    check: ["tmux", "-V"],
    install: { linux: "sudo apt install tmux", darwin: "brew install tmux" },
    docs: "https://github.com/tmux/tmux/wiki/Installing",
    optional: true,
  },
];

// installers that need root or a package manager are shown to copy, never run from here
const SAFE = (cmd: string) => !/\b(sudo|su|brew|apt|apt-get|dnf|yum|pacman|zypper|snap|port|xcode-select)\b/.test(cmd) && !/^see /.test(cmd);
const platform = process.platform === "darwin" ? "darwin" : "linux";

export interface SetupItem {
  source: string;
  sourceName: string;
  req: Requirement;
  found: boolean;
  version?: string;
  // undefined when there's no way to tell
  authed?: boolean;
  install?: string;
  canInstall: boolean;
  tokens: { spec: SettingSpec; value?: SettingValue }[];
}

async function check(source: string, sourceName: string, req: Requirement, env: Record<string, string>, settings: Record<string, SettingValue> = {}, specs: SettingSpec[] = []): Promise<SetupItem> {
  const out = await run(req.check[0], req.check.slice(1), { timeout: 8000, env }).then(
    (o) => ({ ok: true, line: o.trim().split("\n")[0] }),
    () => ({ ok: false, line: "" }),
  );
  let authed: boolean | undefined;
  if (out.ok && req.auth) authed = await run(req.auth[0], req.auth.slice(1), { timeout: 10_000, env }).then(() => true, () => false);
  if (out.ok && source === "core" && req.id === "claude") authed = (await detectBilling()).kind !== "unknown";
  const install = req.install?.[platform];
  return {
    source,
    sourceName,
    req,
    found: out.ok,
    version: out.line.slice(0, 80) || undefined,
    authed,
    install,
    canInstall: !!install && SAFE(install),
    tokens: (req.settings ?? []).map((key) => ({ spec: specs.find((s) => s.key === key)!, value: settings[key] })).filter((t) => t.spec),
  };
}

export async function setupStatus() {
  const items = await Promise.all([
    ...core.map((r) => check("core", "cockpit", r, {})),
    ...pluginRequirements().flatMap((p) => p.requires.map((r) => check(p.plugin, p.name, r, p.env, p.settings, p.specs))),
  ]);
  const skills = skillsStatus();
  return { platform, items, skills, missing: items.filter((i) => !i.req.optional && (!i.found || i.authed === false)).length + skills.filter((s) => s.required && s.state === "missing").length };
}

function find(source: string, id: string) {
  if (source === "core") return { req: core.find((r) => r.id === id) };
  const p = pluginRequirements().find((x) => x.plugin === source);
  return { req: p?.requires.find((r) => r.id === id) };
}

export function install(source: string, id: string) {
  const { req } = find(source, id);
  const cmd = req?.install?.[platform];
  if (!req || !cmd || !SAFE(cmd)) throw Object.assign(new Error("this one has to be installed by hand"), { status: 400 });
  return startJob(`install ${req.name}`, cmd, homedir());
}

// logins are interactive, so they get a terminal
export function login(source: string, id: string) {
  const { req } = find(source, id);
  if (!req?.login) throw Object.assign(new Error("nothing to log in to"), { status: 400 });
  return spawnTerm({ cwd: homedir(), command: req.login[0], args: req.login.slice(1), title: `log in · ${req.name}` });
}

// --- skills ------------------------------------------------------------------------
// Skills cockpit itself ships, in skills/ at the repo root, and the ones plugins ship in their own skills/.
// Installing copies the folder into ~/.claude/skills through writeConfig, so an edited copy gets a backup first.

const coreSkillsDir = join(paths.root, "skills");
const installedDir = (name: string) => join(config.claude.dir, "skills", name);

function filesOf(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? filesOf(p, base) : [relative(base, p)];
  });
}

export interface SkillItem {
  source: string;
  sourceName: string;
  name: string;
  required: boolean;
  description?: string;
  shipped: boolean;
  state: "installed" | "differs" | "missing";
}

function skillStatus(source: string, sourceName: string, name: string, required: boolean, shippedDir?: string): SkillItem {
  const shipped = !!shippedDir && existsSync(join(shippedDir, "SKILL.md"));
  const target = installedDir(name);
  const installed = existsSync(join(target, "SKILL.md"));
  let state: SkillItem["state"] = installed ? "installed" : "missing";
  // an older or edited copy counts as different, so Setup can offer the shipped one
  if (installed && shipped && filesOf(shippedDir!).some((f) => !existsSync(join(target, f)) || readFileSync(join(target, f), "utf8") !== readFileSync(join(shippedDir!, f), "utf8"))) state = "differs";
  const md = shipped ? readFileSync(join(shippedDir!, "SKILL.md"), "utf8") : installed ? readFileSync(join(target, "SKILL.md"), "utf8") : "";
  return { source, sourceName, name, required, description: frontmatter(md)?.description, shipped, state };
}

function skillSources() {
  const core = existsSync(coreSkillsDir)
    ? readdirSync(coreSkillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ source: "core", sourceName: "cockpit", name: d.name, required: false, dir: join(coreSkillsDir, d.name) }))
    : [];
  const fromPlugins = pluginRequirements().flatMap((p) => p.skills.map((s) => ({ source: p.plugin, sourceName: p.name, name: s.name, required: !!s.required, dir: join(p.dir, "skills", s.name) })));
  // a skill the review prompt calls by name is needed while reviews are possible
  const used = (name: string) => !!activeCodeHost() && config.reviews.command.includes(`/${name}`);
  return [...core, ...fromPlugins].map((s) => ({ ...s, required: s.required || used(s.name) }));
}

export const skillsStatus = () => skillSources().map((s) => skillStatus(s.source, s.sourceName, s.name, s.required, s.dir));

export async function installSkill(source: string, name: string) {
  const s = skillSources().find((x) => x.source === source && x.name === name);
  if (!s || !existsSync(join(s.dir, "SKILL.md"))) throw Object.assign(new Error("this skill doesn't ship with cockpit or the plugin, install it yourself"), { status: 400 });
  for (const f of filesOf(s.dir)) await writeConfig(join(installedDir(name), f), readFileSync(join(s.dir, f), "utf8"));
  return skillStatus(s.source, s.sourceName, s.name, s.required, s.dir);
}
