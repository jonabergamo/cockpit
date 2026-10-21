import type { Cockpit, PullRequest } from "@cockpit/shared";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, onAccent } from "@cockpit/shared";
import { bundledDir, parseManifest, parseTheme } from "../src/plugins.ts";

describe("plugins", () => {
  it("reads a minimal manifest and fills the defaults", () => {
    const m = parseManifest({ id: "my-thing", name: "My thing", api: 1 });
    expect(m.version).toBe("0.0.0");
    expect(m.settings).toEqual([]);
  });

  it("refuses bad ids, newer api versions and unknown setting types", () => {
    expect(() => parseManifest({ id: "My Thing", name: "x", api: 1 })).toThrow();
    expect(() => parseManifest({ id: "x", name: "x", api: 99 })).toThrow();
    expect(() => parseManifest({ id: "x", name: "x", api: 1, settings: [{ key: "a", label: "A", type: "colour" }] })).toThrow();
  });

  it("checks theme palettes", () => {
    const ui = { ground: "#000000", panel: "#111111", raised: "#222222", ink: "#ffffff", muted: "#aaaaaa", faint: "#888888", line: "#333333", accent: "#6f93f5", amber: "#e0a93a", green: "#5cbf86", red: "#e8706a" };
    expect(() => parseTheme({ id: "t", name: "T", scheme: "dark", ui, ansi: Array(16).fill("#ffffff") })).not.toThrow();
    expect(() => parseTheme({ id: "t", name: "T", scheme: "dark", ui, ansi: Array(15).fill("#ffffff") })).toThrow();
    expect(() => parseTheme({ id: "t", name: "T", scheme: "dark", ui: { ...ui, ink: "white" }, ansi: Array(16).fill("#ffffff") })).toThrow();
  });

  // every bundled plugin parses, folder name and id agree, and its themes read as well as the built-in ones
  for (const name of readdirSync(bundledDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    it(`bundled ${name} is valid`, () => {
      const dir = join(bundledDir, name);
      expect(parseManifest(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"))).id).toBe(name);
      let themes: string[] = [];
      try {
        themes = readdirSync(join(dir, "themes"));
      } catch {}
      for (const f of themes) {
        const t = parseTheme(JSON.parse(readFileSync(join(dir, "themes", f), "utf8")));
        const low = (["ink", "muted", "faint", "accent", "green", "amber", "red"] as const).filter((k) => contrast(t.ui[k], t.ui.panel) < (k === "ink" || k === "muted" ? 4.5 : 3));
        expect(low, t.id).toEqual([]);
        expect(contrast(onAccent(t), t.ui.accent), `${t.id} on-accent`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

import { parseConcat as jiraConcat } from "../../plugins/jira/server.ts";
import { parseConcat } from "../src/util.ts";

describe("jira plugin", () => {
  it("splits back to back json pages like the core helper", () => {
    const text = '{"a":1}\n{"b":"}{\\"x"}\n[1,2]';
    expect(jiraConcat(text)).toEqual(parseConcat(text));
  });
});

import { existsSync } from "node:fs";
import { frontmatter } from "../src/claude/memory.ts";

describe("shipped skills", () => {
  const dirs = [join(bundledDir, "..", "skills"), ...readdirSync(bundledDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(bundledDir, d.name, "skills"))];
  for (const dir of dirs.filter(existsSync)) {
    for (const name of readdirSync(dir)) {
      it(`${name} has a SKILL.md named after its folder`, () => {
        const fm = frontmatter(readFileSync(join(dir, name, "SKILL.md"), "utf8"));
        expect(fm?.name).toBe(name);
        expect(fm?.description?.length).toBeGreaterThan(40);
      });
    }
  }
});

import type { AccessProvider } from "@cockpit/shared";
import tailscale from "../../plugins/tailscale/server.ts";
import { allowed } from "../src/auth.ts";

import { mergeQueues } from "../src/providers.ts";

describe("the review queue", () => {
  const pr = (url: string, createdAt: string): PullRequest => ({
    number: Number(url.split("/").pop()),
    title: url,
    url,
    branch: "b",
    state: "OPEN",
    isDraft: false,
    createdAt,
  });

  it("puts every source's PRs in one list, oldest first", () => {
    const host = [pr("https://h/pull/2", "2026-02-02"), pr("https://h/pull/9", "2026-01-01")];
    const plugin = [pr("https://h/pull/5", "2026-01-15")];
    expect(mergeQueues([host, plugin]).map((p) => p.number)).toEqual([9, 5, 2]);
  });

  it("shows a PR once when two sources both have it", () => {
    const same = "https://h/pull/7";
    const merged = mergeQueues([[pr(same, "2026-01-01")], [pr(same, "2026-01-01")]]);
    expect(merged).toHaveLength(1);
  });

  it("keeps the code host's version of a PR a plugin also has", () => {
    const same = "https://h/pull/7";
    const host = { ...pr(same, "2026-01-01"), author: "from-host" };
    const plugin = { ...pr(same, "2026-01-01"), author: "from-plugin" };
    expect(mergeQueues([[host], [plugin]])[0].author).toBe("from-host");
  });

  it("is empty when nothing is waiting", () => {
    expect(mergeQueues([[], []])).toEqual([]);
  });
});

describe("access", () => {
  it("lets this machine in and nobody else when no access plugin is on", () => {
    expect(allowed(new Headers({ host: "127.0.0.1:8770" }), "127.0.0.1")).toBe(true);
    expect(allowed(new Headers({ host: "box:8770" }), "192.168.1.20")).toBe(false);
    // a proxy on this machine still needs a plugin to vouch for who's behind it
    expect(allowed(new Headers({ "x-forwarded-for": "100.1.2.3" }), "127.0.0.1")).toBe(false);
  });

  it("refuses requests from another site", () => {
    expect(allowed(new Headers({ host: "127.0.0.1:8770", origin: "https://evil.example" }), "127.0.0.1")).toBe(false);
  });

  it("tailscale only trusts its login header from a local proxy", () => {
    let a: AccessProvider | undefined;
    tailscale({ setting: () => "me@example.com", access: (p: AccessProvider) => (a = p) } as unknown as Cockpit);
    const req = (h: Record<string, string>, local = true) => ({ header: (k: string) => h[k], local, remote: local ? "127.0.0.1" : "100.1.2.3" });
    expect(a!.allow(req({ "x-forwarded-for": "100.1.2.3", "tailscale-user-login": "me@example.com" }))).toBe(true);
    expect(a!.allow(req({ "x-forwarded-for": "100.1.2.3", "tailscale-user-login": "someone@example.com" }))).toBe(false);
    expect(a!.allow(req({ "x-forwarded-for": "100.1.2.3", "tailscale-user-login": "me@example.com" }, false))).toBe(false);
    expect(a!.allow(req({ "tailscale-user-login": "me@example.com" }))).toBe(false);
  });
});
