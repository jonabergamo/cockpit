// What a folder's code changed, as a diff a reviewer can read: cockpit's chat reviews it (chat.mjs --review), and a
// review line on the canvas hands it over with the turn that made it. Lock files, generated and binary files are
// named rather than shown, and the whole is cut short at a size a model can take.
// Plain JavaScript with no packages, so chat.mjs runs on any machine cockpit is on.
import { execFile } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const MAX_DIFF = 40_000;

const LOCK = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|Podfile\.lock|pubspec\.lock|flake\.lock|mix\.lock|packages\.lock\.json)$/;
const GENERATED = /\.min\.(?:js|css)$|\.map$|(?:^|\/)(?:dist|build|out|coverage|\.next|__generated__)\//;
export const nameOnly = (path) => LOCK.test(path) || GENERATED.test(path);

export function git(cwd, args, env) {
  return new Promise((done) =>
    execFile("git", args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (err, out) => done(err ? undefined : out)),
  );
}

export const topOf = async (cwd) => (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim() || undefined;

// The whole working tree as it is now, untracked files too (what .gitignore leaves out stays out), as a tree in the
// repo's objects. It goes through a copy of the index, so what you've staged is left as it was.
export async function snapshot(cwd) {
  const top = await topOf(cwd);
  if (!top) return undefined;
  const index = (await git(top, ["rev-parse", "--git-path", "index"]))?.trim();
  if (!index) return undefined;
  const tmp = join(tmpdir(), `cockpit-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // a repo with nothing staged yet has no index, and starts from an empty one
  await copyFile(resolve(top, index), tmp).catch(() => undefined);
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    if ((await git(top, ["add", "-A"], env)) === undefined) return undefined;
    return (await git(top, ["write-tree"], env))?.trim() || undefined;
  } finally {
    await rm(tmp, { force: true });
  }
}

// From one commit or tree to another: the diff of the files worth reading, and the names of those that aren't
export async function diffBetween(cwd, from, to) {
  const top = await topOf(cwd);
  if (!top) return undefined;
  const stat = await git(top, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", from, to]);
  if (stat === undefined) return undefined;
  const files = [];
  const skipped = [];
  for (const row of stat.split("\0").filter(Boolean)) {
    const [added, , path] = row.split("\t");
    if (!path) continue;
    files.push(path);
    if (added === "-" || nameOnly(path)) skipped.push(path);
  }
  const diff = files.length > skipped.length ? ((await git(top, ["diff", "--no-renames", "--no-ext-diff", "--no-color", from, to, "--", ".", ...skipped.map((p) => `:(exclude,literal)${p}`)])) ?? "") : "";
  return { files, skipped, diff };
}

// a diff cut at a line, at most max characters
export function capDiff(diff, max = MAX_DIFF) {
  if (diff.length <= max) return { text: diff, cut: false, size: diff.length };
  const at = diff.lastIndexOf("\n", max);
  return { text: diff.slice(0, at > 0 ? at : max), cut: true, size: diff.length };
}

// a fence the diff itself can't close
export function fenced(text, lang = "diff") {
  const longest = Math.max(2, ...(text.match(/`{3,}/g) ?? []).map((s) => s.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}
