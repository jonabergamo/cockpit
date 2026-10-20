import { describe, expect, it } from "vitest";
import { contrast, onAccent, themes } from "@cockpit/shared";

describe("themes", () => {
  it("have unique ids and full palettes", () => {
    expect(new Set(themes.map((t) => t.id)).size).toBe(themes.length);
    for (const t of themes) {
      expect(Object.keys(t.ui)).toHaveLength(11);
      expect(t.ansi).toHaveLength(16);
      for (const c of [...Object.values(t.ui), ...t.ansi]) expect(c, t.id).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  // text bars on the panel, where almost everything sits
  const bars: [keyof (typeof themes)[number]["ui"], number][] = [
    ["ink", 4.5],
    ["muted", 4.5],
    ["faint", 3],
    ["accent", 3],
    ["green", 3],
    ["amber", 3],
    ["red", 3],
  ];

  for (const t of themes) {
    it(`${t.name} reads well`, () => {
      const low = bars.filter(([k, min]) => contrast(t.ui[k], t.ui.panel) < min).map(([k, min]) => `${k} ${contrast(t.ui[k], t.ui.panel).toFixed(2)} < ${min}`);
      const on = contrast(onAccent(t), t.ui.accent);
      if (on < 4.5) low.push(`on-accent ${on.toFixed(2)} < 4.5`);
      expect(low).toEqual([]);
    });
  }
});
