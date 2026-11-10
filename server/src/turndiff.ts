// What an agent's turn changed in git, for a review line on the canvas to hand over with the turn: the reviewer reads
// the code, not only the agent's account of it. The working tree is marked when the turn starts (commits, staged,
// unstaged and new files alike) and diffed against when it ends. It runs on the machine the agent's folder is on.
import { capDiff, diffBetween, fenced, MAX_DIFF, snapshot } from "../bin/diff.mjs";

export const markTree = (cwd: string) => snapshot(cwd);

// The part of the relayed message that shows the change; undefined when the folder isn't a git repo
export async function turnChanges(cwd: string, from: string): Promise<string | undefined> {
  const now = await snapshot(cwd);
  if (!now) return undefined;
  if (now === from) return "The turn changed nothing in git.";
  const d = await diffBetween(cwd, from, now);
  if (!d) return undefined;
  if (!d.files.length) return "The turn changed nothing in git.";
  const { text, cut, size } = capDiff(d.diff);
  const files = `${d.files.length} file${d.files.length === 1 ? "" : "s"}`;
  return [
    `What the turn changed in git (${files}, from cockpit's diff of the folder before and after it):`,
    ...(d.diff.trim() ? [fenced(text)] : []),
    ...(d.skipped.length ? [`Also changed, named only (lock, generated or binary): ${d.skipped.join(", ")}`] : []),
    ...(cut ? [`(The diff is cut at ${MAX_DIFF / 1000}k of ${Math.round(size / 1000)}k characters, so judge only what's there.)`] : []),
  ].join("\n\n");
}
