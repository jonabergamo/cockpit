import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askDiff, gitUrl, subPath, usesOf } from "../src/pluginInstall.ts";

describe("gitUrl", () => {
  it("takes https, ssh and GitHub's owner/name", () => {
    expect(gitUrl("acme/cockpit-linear")).toBe("https://github.com/acme/cockpit-linear.git");
    expect(gitUrl("https://gitlab.com/acme/plugin.git/")).toBe("https://gitlab.com/acme/plugin.git");
    expect(gitUrl("git@github.com:acme/plugin.git")).toBe("git@github.com:acme/plugin.git");
  });

  it("refuses options, local paths and other schemes", () => {
    for (const bad of ["--upload-pack=touch /tmp/x", "/home/me/repo", "file:///etc", "ext::sh -c touch", "http://example.com/a"]) expect(() => gitUrl(bad)).toThrow();
  });
});

describe("subPath", () => {
  it("keeps a folder inside the repo", () => {
    expect(subPath("/plugins/linear/")).toBe("plugins/linear");
    expect(subPath("")).toBeUndefined();
  });

  it("refuses one that climbs out", () => {
    expect(() => subPath("../../etc")).toThrow();
    expect(() => subPath("plugins/../../x")).toThrow();
  });
});

it("says what an update newly asks for", () => {
  const before = { settings: ["Team"], secrets: ["Token"], commands: [], skills: [] };
  const after = { settings: ["Team", "Project"], secrets: [], commands: ["linear CLI"], skills: [] };
  expect(askDiff(before, after)).toEqual(["new settings: Project", "no longer secrets: Token", "new commands: linear CLI"]);
});

it("lists which parts of the plugin API its code calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-"));
  writeFileSync(join(dir, "server.ts"), `export default function setup(k) { k.route("GET", "/x", () => 1); k.run("curl", []); }`);
  expect(usesOf(dir)).toEqual(["runs commands on this machine", "adds API routes"]);
});

// the whole path with git cloning a local fixture instead of the network: look, install, see where it came
// from, find it up to date, then remove it
describe("installing from a link", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, mkdirSync, readFileSync } = await import("node:fs");
  const util = await import("../src/util.ts");
  const { vi } = await import("vitest");

  const fixture = mkdtempSync(join(tmpdir(), "plugin-src-"));
  mkdirSync(join(fixture, "plugins", "hello"), { recursive: true });
  writeFileSync(join(fixture, "plugins", "hello", "plugin.json"), JSON.stringify({ id: "hello-link", name: "Hello", api: 1, settings: [{ key: "token", label: "Token", type: "secret", env: "HELLO_TOKEN" }] }));
  mkdirSync(join(fixture, "plugins", "hello-link"));
  writeFileSync(join(fixture, "plugins", "hello-link", "plugin.json"), JSON.stringify({ id: "hello-link", name: "Hello", api: 1 }));
  const git = (...a: string[]) => execFileSync("git", ["-C", fixture, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "first");

  const real = util.run;
  vi.spyOn(util, "run").mockImplementation((cmd, args, opts) => {
    if (cmd === "git" && args[0] === "clone") return real("git", ["clone", "-q", "--", fixture, args.at(-1)!], opts);
    return real(cmd, args, opts);
  });
  const { install, preview, uninstall, updatePreview } = await import("../src/pluginInstall.ts");
  const { listPlugins, userDir } = await import("../src/plugins.ts");

  it("refuses a folder with no plugin.json", async () => {
    await expect(preview({ url: "acme/plugins", path: "nope" })).rejects.toThrow(/no plugin.json in nope/);
  });

  it("reads what it asks for without running anything", async () => {
    const v = await preview({ url: "acme/plugins", path: "plugins/hello" });
    expect(v.asks.secrets).toEqual(["Token (as HELLO_TOKEN)"]);
    expect(v.hasCode).toBe(false);
  });

  it("installs off and pinned, then updates and removes", async () => {
    const v = await preview({ url: "acme/plugins", path: "plugins/hello-link" });
    expect(v.replaces).toBeUndefined();
    const done = await install(v.token);
    expect(done).toEqual({ id: "hello-link", on: false, updated: false });
    const dir = join(userDir, "hello-link");
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, ".cockpit-source.json"), "utf8")).path).toBe("plugins/hello-link");
    const p = listPlugins().plugins.find((x) => x.manifest.id === "hello-link");
    expect(p?.on).toBe(false);
    expect(p?.source?.url).toBe("https://github.com/acme/plugins.git");
    expect((await updatePreview("hello-link")).upToDate).toBe(true);
    await uninstall("hello-link");
    expect(existsSync(dir)).toBe(false);
  });
});
