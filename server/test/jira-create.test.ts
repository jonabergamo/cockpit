import { describe, expect, it } from "vitest";
import { createJson } from "../../plugins/jira/server.ts";

const presets = { Web: { customfield_10100: [{ value: "Web" }] }, Mobile: { customfield_10100: [{ value: "Mobile" }] } };

describe("a new Jira ticket", () => {
  it("fills in the preset, criteria, points, sprint and epic as custom fields", () => {
    const j = createJson(
      { summary: "Saved cards", type: "Story", description: "First part.\n\nSecond part.", preset: "Mobile", parent: "ACME-1", inSprint: true, fields: { ac: "- shows the cards\n* can pick one\n", points: 2 } },
      { project: "ACME", presets, acField: "customfield_10200", pointsField: "customfield_10016", sprintField: "customfield_10020", epicField: "customfield_10014", sprintId: 9 },
    );
    expect(j).toMatchObject({ projectKey: "ACME", type: "Story", summary: "Saved cards" });
    expect(j.description!.content).toHaveLength(2);
    expect(j.additionalAttributes).toMatchObject({ customfield_10100: [{ value: "Mobile" }], customfield_10016: 2, customfield_10020: 9, customfield_10014: "ACME-1" });
    const ac = (j.additionalAttributes as Record<string, { content: { content: unknown[] }[] }>).customfield_10200;
    expect(ac.content[0].content).toHaveLength(2);
  });

  it("uses the first preset by default and leaves out what wasn't given", () => {
    const j = createJson({ summary: "Fix it" }, { project: "ACME", presets, pointsField: "customfield_10016" });
    expect(j).toEqual({ projectKey: "ACME", type: "Task", summary: "Fix it", additionalAttributes: { customfield_10100: [{ value: "Web" }] } });
  });
});
