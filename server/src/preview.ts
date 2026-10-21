// A preview per worktree: repo.devCommand started in a cockpit terminal on a free port, so the app can be
// opened (or embedded) next to the session that's changing it.
import { createServer } from "node:net";
import { config } from "./config.ts";
import { boardChanged } from "./board.ts";
import { kill, listTerms, spawnTerm } from "./pty.ts";
import { readRow, writeRow } from "./settings.ts";
import { fill } from "./util.ts";

const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });

async function freePort(taken: number[]) {
  for (let p = 5300; p < 5400; p++) if (!taken.includes(p) && (await free(p))) return p;
  throw new Error("No free port between 5300 and 5399");
}

const key = (worktree: string) => `preview:${worktree}`;
type Saved = { port: number; term: string };

export function previewOf(worktree: string) {
  const p = readRow<Saved>(key(worktree));
  if (!p) return null;
  const term = listTerms().find((t) => t.id === p.term && t.exited === undefined);
  return { port: p.port, term: p.term, running: !!term };
}

export async function startPreview(worktree: string) {
  if (!config.repo.devCommand) throw new Error('Set repo.devCommand in config.local.toml first, e.g. "pnpm dev --port {port}"');
  const now = previewOf(worktree);
  if (now?.running) return now;
  const taken = listTerms().flatMap((t) => (t.title.startsWith("dev · ") ? [Number(t.title.split(":").pop())] : []));
  const port = await freePort(taken);
  const name = worktree.split("/").slice(-2).join("/");
  const command = fill(config.repo.devCommand, { port: String(port), path: worktree, name });
  const t = spawnTerm({ cwd: worktree, command: "bash", args: ["-lc", command], title: `dev · ${name} :${port}` });
  writeRow(key(worktree), { port, term: t.id });
  boardChanged();
  return { port, term: t.id, running: true };
}

export function stopPreview(worktree: string) {
  const p = readRow<Saved>(key(worktree));
  if (p) kill(p.term);
  boardChanged();
}
