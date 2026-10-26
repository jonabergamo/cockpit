import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexLimits, codexLine, codexRows, indexCodexUsage } from "../src/codexUsage.ts";

const meta = (id: string, cwd: string) => JSON.stringify({ timestamp: "2026-10-26T10:00:00.000Z", type: "session_meta", payload: { id, cwd } });
const ctx = (model: string) => JSON.stringify({ timestamp: "2026-10-26T10:00:01.000Z", type: "turn_context", payload: { model } });
const count = (ts: string, input: number, cached: number, output: number, limits?: object) =>
  JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } }, rate_limits: limits ?? null },
  });
const weekly = (pct: number, resets: number) => ({ primary: { used_percent: pct, window_minutes: 10080, resets_at: resets }, secondary: null, plan_type: "plus" });

describe("Codex usage", () => {
  it("reads the lines that matter and leaves the rest", () => {
    expect(codexLine(meta("s1", "/w"))).toEqual({ session: { id: "s1", cwd: "/w" } });
    expect(codexLine(ctx("gpt-x"))).toEqual({ model: "gpt-x" });
    expect(codexLine(JSON.stringify({ type: "response_item", payload: { text: "hi" } }))).toBeUndefined();
    const l = codexLine(count("2026-10-26T10:01:00.000Z", 100, 40, 10, weekly(12.5, 1_900_000_000)));
    expect(l?.usage?.total.total_tokens).toBe(110);
    expect(l?.limits).toEqual({ at: Date.parse("2026-10-26T10:01:00.000Z"), plan: "plus", windows: [{ minutes: 10080, pct: 12.5, resetsAt: 1_900_000_000_000 }] });
  });

  it("turns running totals into each turn's tokens, once, across reads", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const day = join(home, "sessions/2026/10/26");
    mkdirSync(day, { recursive: true });
    const file = join(day, "rollout-2026-10-26T10-00-00-s-test-1.jsonl");
    const old = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      writeFileSync(file, [meta("s-test-1", "/work/app"), ctx("gpt-x"), count("2026-10-26T10:01:00.000Z", 1000, 400, 50), ""].join("\n"));
      await indexCodexUsage();
      // the same totals again (a limits-only update) add nothing; the next turn adds what it grew by
      appendFileSync(file, [count("2026-10-26T10:01:05.000Z", 1000, 400, 50, weekly(3, 1_900_000_000)), count("2026-10-26T10:02:00.000Z", 1600, 900, 80), ""].join("\n"));
      await indexCodexUsage();
      await indexCodexUsage();
      const rows = codexRows("2026-10-26T00:00:00.000Z").filter((r) => r.session_id === "s-test-1");
      expect(rows.map((r) => [r.input, r.cache_read, r.output, r.model, r.cwd])).toEqual([
        [600, 400, 50, "gpt-x", "/work/app"],
        [100, 500, 30, "gpt-x", "/work/app"],
      ]);
      // a weekly-only plan fills the weekly window and leaves the 5 hour one empty
      const l = codexLimits(0);
      expect(l.plan).toBe("plus");
      expect(l.latest?.seven).toEqual({ pct: 3, resetsAt: 1_900_000_000_000 });
      expect(l.latest?.five).toEqual({});
    } finally {
      process.env.CODEX_HOME = old;
    }
  });
});
