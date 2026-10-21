import { describe, expect, it } from "vitest";
import { notesOnly, reachedLive } from "../src/notes.ts";

describe("notesOnly", () => {
  it("keeps the notes from a fenced reply and drops the talk around it", () => {
    const out = ["Warning: no stdin data received in 3s, proceeding without it.", "```", "Team Updates:", "- 18 of 41 points done", "```", "", "That's 590 characters, so I cut a few things:", "- the rota tickets"].join("\n");
    expect(notesOnly(out)).toBe("Team Updates:\n- 18 of 41 points done");
  });

  it("leaves a plain reply as it is", () => {
    expect(notesOnly("\nAlex\n- shipped the export\n")).toBe("Alex\n- shipped the export");
  });
});

describe("reachedLive", () => {
  // git log order: newest first
  const log = [
    "2026-10-20T17:05:03+01:00\tMerge pull request #11702 from acme/revert/ACME-27-session-invalidation\t",
    "2026-10-20T12:27:47-03:00\tRevert \"Merge pull request #11637 from acme/feat/ACME-27/sessions\"\t",
    "2026-10-20T15:29:06+01:00\tMerge pull request #11637 from acme/feat/ACME-27/sessions\t",
    "2026-10-15T10:00:00+01:00\tMerge pull request #11629 from acme/feat/ACME-35/search\t",
    "2026-10-14T10:00:00+01:00\tFE - ACME-40 - Squashed change (#11600)",
  ].join("\n");

  it("dates when a ticket reached the branch, from merge and squash subjects", () => {
    const live = reachedLive(log, ["ACME-35", "ACME-40", "ACME-99"]);
    expect(live.get("ACME-35")).toEqual({ at: "2026-10-15", reverted: false });
    expect(live.get("ACME-40")).toEqual({ at: "2026-10-14", reverted: false });
    expect(live.has("ACME-99")).toBe(false);
  });

  it("marks work that a revert took back out, even when the revert came in as a merge", () => {
    expect(reachedLive(log, ["ACME-27"]).get("ACME-27")?.reverted).toBe(true);
  });

  it("doesn't take ACME-3 for ACME-35", () => {
    expect(reachedLive(log, ["ACME-3"]).has("ACME-3")).toBe(false);
  });
});
