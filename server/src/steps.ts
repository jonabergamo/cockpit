// Steps cockpit reads from a run's output itself, when no plugin reads that kind of output: Playwright's list
// reporter, one line per test as it ends, grouped by the file it's in.
import type { RunStep } from "@cockpit/shared";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
//   ✓   2 [Chrome] › tests/login.test.ts:22:9 › Login › valid credentials @smoke (4.4s)
const TEST = /^\s*(✓|✔|✘|×|x|-|ok)\s+\d+\s+(?:\[([^\]]+)\]\s+›\s+)?(.+?)(?:\s+\((?:\d+(?:\.\d+)?(?:ms|s|m|h)\s?)+\))?\s*$/;
const STATE: Record<string, RunStep["state"]> = { "✓": "ok", "✔": "ok", ok: "ok", "✘": "failed", "×": "failed", x: "failed", "-": "skipped" };

export function playwrightSteps(lines: string[]): RunStep[] {
  const out: RunStep[] = [];
  let file = "";
  for (const raw of lines) {
    const m = raw.replace(ANSI, "").split("\r").pop()!.match(TEST);
    if (!m || !m[3].includes("›")) continue;
    const [where, ...title] = m[3].split(/\s+›\s+/);
    const name = where.replace(/:\d+:\d+$/, "").split("/").pop()!;
    if (name !== file) {
      file = name;
      out.push({ text: name, state: "section", depth: 0 });
    }
    const text = title.join(" › ").replace(/(\s+@[\w:-]+)+$/, "").trim();
    out.push({ text: m[2] && m[2] !== "setup" ? text : text || name, state: STATE[m[1]], depth: 1 });
  }
  return out;
}
