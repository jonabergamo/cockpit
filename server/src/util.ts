import { execFile, spawn } from "node:child_process";
import { config } from "./config.ts";

let keyRe = new RegExp(config.repo.keyPattern, "i");
// the active tracker's pattern wins over repo.keyPattern
export const setKeyPattern = (p?: string) => void (keyRe = new RegExp(p || config.repo.keyPattern, "i"));

export function ticketOf(...hay: (string | undefined)[]) {
  for (const s of hay) {
    const m = s?.match(keyRe);
    if (m) return m[0].toUpperCase();
  }
}

export function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; input?: string; env?: Record<string, string> } = {}) {
  return new Promise<string>((resolve, reject) => {
    const env = opts.env ? { ...process.env, ...opts.env } : undefined;
    const child = execFile(cmd, args, { cwd: opts.cwd, env, timeout: opts.timeout ?? 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} ${args.join(" ")}: ${stderr.trim() || err.message}`));
      resolve(stdout);
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export const runJson = async <T = any>(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) =>
  JSON.parse(await run(cmd, args, opts)) as T;

// Only quote when needed, so templates like ssh "code --folder-uri ...{path}" keep working.
// `acli --paginate --json` prints one JSON document per page, back to back.
export function parseConcat(text: string): any[] {
  const out: any[] = [];
  let depth = 0;
  let start = -1;
  let str = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (str) {
      if (ch === "\\") i++;
      else if (ch === '"') str = false;
      continue;
    }
    if (ch === '"') str = true;
    else if (ch === "{" || ch === "[") {
      if (depth++ === 0) start = i;
    } else if (ch === "}" || ch === "]") {
      if (--depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  return out;
}

const quote = (s: string) => (/^[\w./:@+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function fill(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? quote(vars[k]) : m));
}

// Runs a shell command and streams its output, used for the user-configured templates.
export function stream(command: string, onChunk: (s: string) => void, cwd?: string) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: process.env });
    let out = "";
    const push = (b: Buffer) => {
      const s = b.toString();
      out += s;
      onChunk(s);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

export const slugify = (s: string, max = 40) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max)
    .replace(/-$/, "");

export const day = (ts: string | number | Date) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
