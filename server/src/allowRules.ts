// "You always say yes": the permission prompts answered from cockpit are kept with the Claude Code allow rule that
// would have covered them, and a rule you keep approving (and never turn down) is offered for your settings.
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AskInfo, RuleSuggestion } from "@cockpit/shared";
import { askOf } from "./agents.ts";
import { writeConfig, writeProjectSettings } from "./claude/memory.ts";
import { getSession } from "./claude/sessions.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { getSettings } from "./settings.ts";
import { run } from "./util.ts";

db.exec(`
  create table if not exists prompt_answers (
    id integer primary key autoincrement,
    tool text not null,
    input text,
    rule text,
    choice text not null,
    session text,
    cwd text,
    at integer not null
  );
  create index if not exists prompt_answers_rule on prompt_answers (rule, at);
  create table if not exists prompt_rules_dismissed (rule text primary key, at integer not null);
`);

const WINDOW_MS = 30 * 24 * 3600_000;
// tools whose prompt isn't a permission one: a question, or leaving plan mode
const NOT_PERMISSION = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);
// a command that chains, pipes, redirects or substitutes can't be said as one prefix
const SHELL_OPS = /&&|\|\||[|;&<>`\n]|\$\(/;
// the commands whose second word says what they do (git status, pnpm test); the rest are known by their first
const VERBED = new Set(["git", "gh", "npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx", "deno", "docker", "kubectl", "cargo", "go", "uv", "poetry", "make", "just", "terraform", "brew", "pip", "pip3", "dotnet", "mvn", "gradle", "./gradlew", "turbo", "nx", "rails", "bundle", "mix", "composer"]);
// and where that second word runs something named by a third (pnpm run test, npm exec tsc)
const RUNNERS = new Set(["run", "exec", "dlx", "x"]);
const WORD = /^[a-z0-9][\w:.@+-]*$/i;

// the prefix Claude Code's Bash(prefix:*) rule would use for a command, or undefined when it can't be said safely
export function bashPrefix(command: string) {
  const cmd = command.trim();
  if (!cmd || SHELL_OPS.test(cmd)) return;
  const words = cmd.split(/\s+/);
  const first = words[0];
  // an env assignment in front, or a quoted program, isn't a command prefix worth keeping
  if (!/^[\w@.\/+-]+$/.test(first) || first.includes("=")) return;
  const out = [first];
  if (VERBED.has(first) && words[1] && WORD.test(words[1])) {
    out.push(words[1]);
    if (RUNNERS.has(words[1]) && words[2] && WORD.test(words[2])) out.push(words[2]);
  }
  return out.join(" ");
}

// The allow rule in Claude Code's own syntax for a tool call waiting on permission
export function ruleFor(tool: string, input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  if (NOT_PERMISSION.has(tool)) return;
  if (tool === "Bash") {
    const p = typeof i.command === "string" ? bashPrefix(i.command) : undefined;
    return p ? `Bash(${p}:*)` : undefined;
  }
  if (tool === "WebFetch") {
    try {
      return `WebFetch(domain:${new URL(String(i.url)).hostname})`;
    } catch {
      return;
    }
  }
  return /^[\w-]+$/.test(tool) ? tool : undefined;
}

// Never offered, however often you said yes: they delete, push, run anything or reach out of the machine
const DANGER = [
  "rm", "rmdir", "sudo", "su", "doas", "dd", "mkfs", "shred", "chmod", "chown", "kill", "pkill", "killall", "shutdown", "reboot", "halt",
  "eval", "exec", "sh", "bash", "zsh", "fish", "source", ".", "env", "xargs", "nohup", "time", "watch",
  "curl", "wget", "ssh", "scp", "rsync", "nc", "ncat", "telnet", "ftp",
  "python", "python3", "node", "perl", "ruby", "php", "osascript", "crontab", "launchctl", "systemctl", "find", "mv",
  "git push", "git reset", "git clean", "git rm", "git checkout", "git restore", "git rebase", "git filter-branch", "git branch", "git config",
  "npm publish", "pnpm publish", "yarn publish", "npm unpublish", "gh api", "gh repo", "gh release", "gh pr merge", "gh secret", "gh auth",
  "docker rm", "docker rmi", "docker system", "docker volume", "kubectl delete", "kubectl exec", "terraform apply", "terraform destroy",
];
// on their own they run whatever comes next
const TOO_BROAD = new Set([...VERBED, "pnpm run", "npm run", "yarn run", "bun run", "pnpm exec", "npm exec", "pnpm dlx", "yarn dlx", "bun x", "uv run", "poetry run", "go run", "cargo run", "docker run", "docker exec"]);

export function dangerous(rule: string) {
  if (rule === "Bash" || /^Bash\(\*?\)$/.test(rule)) return true;
  const m = rule.match(/^Bash\((.+?)(?::\*)?\)$/);
  if (!m) return false;
  const prefix = m[1].trim();
  if (prefix.includes("*") || SHELL_OPS.test(prefix)) return true;
  const words = prefix.split(/\s+/);
  // /bin/rm is rm
  words[0] = basename(words[0]);
  const p = words.join(" ");
  return TOO_BROAD.has(p) || DANGER.some((d) => p === d || p.startsWith(`${d} `));
}

// What an option's label says: Yes, Yes and don't ask again, No and tell Claude...
export function choiceOf(label?: string): "allow" | "deny" | undefined {
  if (!label) return;
  if (/^\s*no\b/i.test(label)) return "deny";
  if (/^\s*yes\b/i.test(label)) return "allow";
}

// The answer a reply gives the menu on screen: a number picks an option, y or n answer it, Esc turns it down
export function answerOf(reply: { keys?: string[]; text?: string }, options: { key: string; label: string }[]) {
  const keys = reply.keys ?? (reply.text?.trim() ? [reply.text.trim()] : []);
  for (const k of keys) {
    if (k === "Escape") return "deny";
    if (/^y(es)?$/i.test(k)) return "allow";
    if (/^n(o)?$/i.test(k)) return "deny";
    if (/^\d$/.test(k)) return choiceOf(options.find((o) => o.key === k)?.label);
  }
}

export function recordAnswer(session: string, ask: Pick<AskInfo, "options" | "pending">, reply: { keys?: string[]; text?: string }, cwd?: string, at = Date.now()) {
  const p = ask.pending;
  if (!p || NOT_PERMISSION.has(p.name) || ask.options.length < 2) return false;
  const choice = answerOf(reply, ask.options);
  if (!choice) return false;
  const input = JSON.stringify(p.input ?? null).slice(0, 2000);
  db.prepare("insert into prompt_answers (tool, input, rule, choice, session, cwd, at) values (?, ?, ?, ?, ?, ?, ?)").run(p.name, input, ruleFor(p.name, p.input) ?? null, choice, session, cwd ?? null, at);
  return true;
}

// Sends a reply to a session, keeping it as an answer when a permission prompt was on its screen. The screen is read
// before the reply goes, since after it the prompt is gone.
export async function answering(session: string, reply: { keys?: string[]; text?: string }, send: () => boolean | Promise<boolean>) {
  if (!getSettings().ruleSuggestions.on) return send();
  const before: AskInfo | undefined = await askOf(session).catch(() => undefined);
  const sent = await send();
  if (sent && before?.options.length && before.pending) {
    try {
      recordAnswer(session, before, reply, getSession(session)?.cwd);
    } catch (e) {
      console.error("keeping a permission answer:", (e as Error).message);
    }
  }
  return sent;
}

// ---- the allow lists already in Claude Code's settings

const readJson = async (path: string) => {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return {};
  try {
    return JSON.parse(text) as { permissions?: { allow?: unknown; deny?: unknown } };
  } catch {
    throw new Error(`can't parse ${path}`);
  }
};
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const bashOf = (rule: string) => rule.match(/^Bash\((.+?)(?::\*|\s\*)?\)$/)?.[1];

// Whether a rule already in the allow list covers this one: the same, the whole tool, a shorter Bash prefix, or the
// whole MCP server
export function covered(rule: string, allow: string[]) {
  const tool = rule.match(/^[\w-]+/)?.[0] ?? rule;
  return allow.some((a) => {
    if (a === rule || a === tool || a === `${tool}(*)`) return true;
    const mine = bashOf(rule);
    const theirs = bashOf(a);
    if (mine && theirs && !theirs.includes("*")) return mine === theirs || mine.startsWith(`${theirs} `) || (a.endsWith(":*)") && mine.startsWith(theirs));
    const server = a.match(/^(mcp__.+?)(?:__\*)?$/)?.[1];
    return !!server && tool.startsWith("mcp__") && tool.startsWith(`${server}__`);
  });
}

const userSettings = () => join(config.claude.dir, "settings.json");
const projectFiles = (root: string) => [join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json")];

// the main checkout a folder belongs to, so a worktree's rule lands in its repo and outlives the worktree
const roots = new Map<string, Promise<string | undefined>>();
export function projectRoot(cwd: string) {
  let r = roots.get(cwd);
  if (!r) {
    r = run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { timeout: 5000 }).then(
      (out) => {
        const [common, top] = out.trim().split("\n");
        return common && basename(common) === ".git" ? dirname(common) : top || undefined;
      },
      () => undefined,
    );
    roots.set(cwd, r);
  }
  return r;
}

async function rulesIn(files: string[]) {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const f of files) {
    const s = await readJson(f);
    allow.push(...list(s.permissions?.allow));
    deny.push(...list(s.permissions?.deny));
  }
  return { allow, deny };
}

// ---- suggestions

export async function suggestions(now = Date.now()): Promise<RuleSuggestion[]> {
  const s = getSettings().ruleSuggestions;
  if (!s.on) return [];
  const rows = db
    .prepare<[number], { rule: string; tool: string; yes: number; no: number; last: number }>(
      `select rule, tool, sum(choice = 'allow') as yes, sum(choice = 'deny') as no, max(at) as last from prompt_answers
       where at > ? and rule is not null and rule not in (select rule from prompt_rules_dismissed) group by rule`,
    )
    .all(now - WINDOW_MS)
    .filter((r) => r.yes >= s.threshold && !r.no && !dangerous(r.rule));
  if (!rows.length) return [];
  const user = await rulesIn([userSettings()]);
  const out: RuleSuggestion[] = [];
  for (const r of rows.sort((a, b) => b.yes - a.yes || b.last - a.last)) {
    if (covered(r.rule, user.allow) || user.deny.includes(r.rule)) continue;
    const latest = db.prepare<[string], { input: string | null; cwd: string | null }>("select input, cwd from prompt_answers where rule = ? order by at desc limit 1").get(r.rule);
    const project = latest?.cwd ? await projectRoot(latest.cwd) : undefined;
    if (project) {
      // the worktree's own settings count too, where Claude Code put a "don't ask again"
      const own = latest?.cwd ? await run("git", ["-C", latest.cwd, "rev-parse", "--show-toplevel"], { timeout: 5000 }).then((o) => o.trim(), () => "") : "";
      const p = await rulesIn([...projectFiles(project), ...(own && own !== project ? projectFiles(own) : [])]).catch(() => ({ allow: [] as string[], deny: [] as string[] }));
      if (covered(r.rule, p.allow) || p.deny.includes(r.rule)) continue;
    }
    out.push({ rule: r.rule, tool: r.tool, approvals: r.yes, lastAt: r.last, example: exampleOf(r.tool, latest?.input), project });
  }
  return out;
}

function exampleOf(tool: string, input?: string | null) {
  if (!input) return;
  try {
    const i = JSON.parse(input) as Record<string, unknown>;
    const v = tool === "Bash" ? i.command : tool === "WebFetch" ? i.url : (i.file_path ?? i.path ?? i.pattern);
    return typeof v === "string" ? v.slice(0, 300) : undefined;
  } catch {
    return;
  }
}

export function dismissRule(rule: string) {
  db.prepare("insert or replace into prompt_rules_dismissed (rule, at) values (?, ?)").run(rule, Date.now());
}

// Adds the rule to the allow list of your settings or the project's settings.local.json (yours, not committed),
// through the Memory editor's save so the file is backed up first
export async function acceptRule(rule: string, where: "user" | "project") {
  if (dangerous(rule)) throw new Error(`${rule} is too broad to allow without asking`);
  const known = db.prepare<[string], { cwd: string | null }>("select cwd from prompt_answers where rule = ? order by at desc limit 1").get(rule);
  if (!known) throw new Error("no answers kept for that rule");
  let path = userSettings();
  if (where === "project") {
    const root = known.cwd ? await projectRoot(known.cwd) : undefined;
    if (!root) throw new Error("its sessions didn't run in a project");
    path = join(root, ".claude", "settings.local.json");
  }
  const text = await readFile(path, "utf8").catch(() => "");
  let json: { permissions?: { allow?: unknown } };
  try {
    json = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} isn't valid JSON; fix it in Memory first`);
  }
  const allow = list(json.permissions?.allow);
  if (!allow.includes(rule)) allow.push(rule);
  json.permissions = { ...json.permissions, allow };
  const content = `${JSON.stringify(json, null, 2)}\n`;
  if (where === "user") await writeConfig(path, content);
  else await writeProjectSettings(path, content);
  return { path };
}
