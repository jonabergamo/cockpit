// What a test runner's output says: how many passed, failed and were skipped, and which tests failed. Vitest, jest,
// mocha, pytest, Django's test runner, go test, Playwright and Maestro, from the plain text of their default
// reporters (colours already stripped).
import type { RunSummary } from "@cockpit/shared";

const MAX_FAILING = 20;
// a duration at the end of a line: "12ms", "(5 ms)", "(0.00s)", "(1m 53s)"
const TOOK = /\s+\(?\d+(?:\.\d+)?\s?(?:ms|s|m)(?:\s\d+(?:\.\d+)?\s?(?:ms|s))?\)?$/;

// One test the same way every time it fails, so runs of it can be compared: no duration, no Playwright project,
// line and column or the rule it draws under the title
export function testName(raw: string) {
  return raw
    .replace(/\s*─+\s*$/, "")
    .replace(TOOK, "")
    .replace(/^\d+\s+(?=\[)/, "")
    .replace(/^\[[^\]]+\]\s+›\s+/, "")
    .replace(/(\.\w+):\d+:\d+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

type Found = { name: string; file?: boolean };

// The tests that failed. A file or package that failed is kept only when no test in the output says why.
function failingOf(text: string[]): string[] {
  const found: Found[] = [];
  const add = (name: string, file = false) => {
    const n = testName(name);
    if (n && !found.some((f) => f.name === n)) found.push({ name: n, file });
  };
  let summary: "mocha" | "playwright" | undefined;
  let flow: string | undefined;
  let maestroFailed = false;
  let tapDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const l = text[i];
    let m: RegExpMatchArray | null;
    // Django and unittest: "FAIL: test_x (app.tests.Class)", or "(app.tests.Class.test_x)" since Python 3.11
    if ((m = l.match(/^(?:FAIL|ERROR):\s+(\w+)\s+\(([\w.]+)\)/))) {
      add(m[2].endsWith(`.${m[1]}`) ? m[2] : `${m[2]}.${m[1]}`);
      continue;
    }
    // pytest's short summary: "FAILED tests/test_x.py::Class::test_y[param] - AssertionError"
    if ((m = l.match(/^(?:FAILED|ERROR)\s+(\S+?\.py(?:::.+?)?)(?:\s+-\s.*)?$/))) {
      add(m[1], !m[1].includes("::"));
      continue;
    }
    // go test: "--- FAIL: TestX (0.00s)", subtests indented under it
    if ((m = l.match(/^\s*--- FAIL:\s+(\S+)/))) {
      add(m[1]);
      continue;
    }
    // vitest's "FAIL  file > suite > test", or a file that failed as a whole; jest's "FAIL path (5 s)"; go's
    // "FAIL\tpkg\t0.01s"
    if ((m = l.match(/^\s*FAIL\s+(\S.*)$/))) {
      // vitest's "FAIL  file [ file ]" is a file that couldn't run at all, which no test of it will say
      const whole = /\s+\[\s*.+\s*\]$/.test(m[1]);
      const what = m[1].replace(/\s+\[\s*.+\s*\]$/, "").replace(/\s+\d+(?:\.\d+)?s$/, "");
      add(what, !whole && !what.includes(" > "));
      continue;
    }
    // a test marked failed as it ends: vitest, jest, Playwright's list reporter
    if ((m = l.match(/^\s*[×✕✗✘]\s+(.+)$/))) {
      add(m[1]);
      continue;
    }
    // TAP, as node --test prints it: "not ok 3 - adds things", indented under its suite. A suite fails after its
    // tests, less indented, and says nothing they didn't.
    if ((m = l.match(/^(\s*)not ok \d+ - (.+?)(?:\s+#\s.*)?$/))) {
      if (m[1].length >= tapDepth) add(m[2]);
      tapDepth = m[1].length;
      continue;
    }
    // jest's "● Suite › test", above why it failed
    if ((m = l.match(/^\s*●\s+(.+)$/))) {
      if (!/^(Console|Test suite failed to run)\b/.test(m[1])) add(m[1]);
      continue;
    }
    // Maestro: "[Failed] flow (1m 2s) (why)" from a suite, or a single flow's "> Flow name" with a step that FAILED
    if ((m = l.match(/^\s*\[Failed\]\s+(.+?)\s+\((?:\d+(?:\.\d+)?\s?(?:ms|s|m|h)\s?)+\)/))) {
      add(m[1]);
      continue;
    }
    if ((m = l.match(/^\s*>\s*Flow\s+(\S.*)$/))) flow ??= m[1];
    if (/\.\.\.\s*FAILED$/.test(l)) maestroFailed = true;
    // the summaries that list each failure after a count: mocha's "2 failing", Playwright's "1 failed"
    if (/^\s*\d+ failing\b/.test(l)) summary = "mocha";
    else if (/^\s*\d+ failed\s*$/.test(l)) summary = "playwright";
    else if (summary === "playwright" && /^\s*\d+ (passed|flaky|skipped|did not run|interrupted)\b/.test(l)) summary = undefined;
    else if (summary === "playwright" && (m = l.match(/^\s+(\[[^\]]+\]\s+›\s+.+)$/))) add(m[1]);
    else if ((m = l.match(/^\s*\d+\)\s+(.+)$/)) && (summary || / › /.test(m[1]))) {
      // Playwright's "1) [chromium] › a.spec.ts:3:1 › title ───" is one line; mocha's title goes on over the lines
      // below it, more indented, up to one ending in ":"
      if (/ › /.test(m[1])) {
        add(m[1]);
        continue;
      }
      const parts = [m[1]];
      while (!parts.at(-1)!.endsWith(":") && i + 1 < text.length && /^\s{4,}\S/.test(text[i + 1]) && parts.length < 8) parts.push(text[++i].trim());
      if (parts.at(-1)!.endsWith(":")) add(parts.join(" ").replace(/:$/, ""));
    }
  }
  if (maestroFailed && flow && !found.length) add(flow);
  const tests = found.filter((f) => !f.file).map((f) => f.name);
  const names = tests.length ? tests : found.map((f) => f.name);
  // the same test seen twice, as "test" and as "file > suite > test", or a go test and its subtest: the longer one
  return names.filter((n) => !names.some((o) => o !== n && (o.endsWith(` > ${n}`) || o.endsWith(` › ${n}`) || o.startsWith(`${n}/`)))).slice(0, MAX_FAILING);
}

const WORDS = /(\d+) (passed|passing|failed|failing|skipped|pending|todo|errors?)\b/gi;
const bucket = (word: string) => (/pass/i.test(word) ? "passed" : /fail|error/i.test(word) ? "failed" : "skipped");

function totalsOf(text: string[]): Pick<RunSummary, "passed" | "failed" | "skipped"> {
  const out: Pick<RunSummary, "passed" | "failed" | "skipped"> = {};
  const add = (k: keyof typeof out, n: number) => (out[k] = (out[k] ?? 0) + n);
  // one line with them all: vitest's "Tests  1 failed | 30 passed", jest's "Tests: 2 failed, 10 passed", pytest's
  // "=== 1 failed, 12 passed in 0.3s ==="
  const total = text.findLast((l) => /^\s*(Tests:?|=+)\s.*\b\d+ (passed|failed)\b/i.test(l));
  if (total) {
    for (const [, n, word] of total.matchAll(WORDS)) add(bucket(word), Number(n));
    return out;
  }
  // a line each: mocha's "2 passing (10ms)" and "1 failing", Playwright's "1 failed" and "3 passed (5s)"; the last
  // of each word counts
  const each = new Map<string, number>();
  for (const l of text) {
    const m = l.match(/^\s*(\d+) (passed|passing|failed|failing|skipped|pending|flaky)(?:\s*\(.*\))?\s*$/);
    if (m) each.set(m[2] === "flaky" ? "passed+" : m[2], Number(m[1]));
  }
  if (each.size) {
    for (const [word, n] of each) add(bucket(word), n);
    return out;
  }
  // TAP's "# pass 134" and "# fail 0"
  const tap = new Map<string, number>();
  for (const l of text) {
    const m = l.match(/^#\s+(pass|fail|skipped|todo)\s+(\d+)\s*$/);
    if (m) tap.set(m[1], Number(m[2]));
  }
  if (tap.size) {
    for (const [word, n] of tap) if (n || word === "pass") add(word === "pass" ? "passed" : word === "fail" ? "failed" : "skipped", n);
    return out;
  }
  // Django and unittest: "Ran 12 tests in 0.5s", then "FAILED (failures=1, errors=2, skipped=3)" or "OK"
  const ran = text.findLast((l) => /^Ran \d+ tests? in /.test(l));
  if (ran) {
    const n = Number(ran.match(/\d+/)![0]);
    const end = text.slice(text.lastIndexOf(ran)).find((l) => /^(FAILED|OK)\b/.test(l)) ?? "";
    const count = (k: string) => Number(end.match(new RegExp(`\\b${k}=(\\d+)`))?.[1] ?? 0);
    const failed = count("failures") + count("errors") + count("unexpected successes");
    const skipped = count("skipped") + count("expected failures");
    return { passed: n - failed - skipped, ...(failed ? { failed } : {}), ...(skipped ? { skipped } : {}) };
  }
  // Maestro's "[Passed] flow (5s)" and "[Failed] flow (5s) (why)"
  const flows = text.filter((l) => /^\s*\[(Passed|Failed)\]\s/.test(l));
  if (flows.length) {
    const failed = flows.filter((l) => /\[Failed\]/.test(l)).length;
    return { passed: flows.length - failed, ...(failed ? { failed } : {}) };
  }
  return out;
}

export function testSummary(text: string[]): RunSummary {
  const out: RunSummary = totalsOf(text);
  const failing = failingOf(text);
  if (failing.length) out.failing = failing;
  return out;
}
