import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { hostFor, listHosts } from "../src/remote/hosts.ts";
import { localHost } from "../src/remote/local.ts";

// Starting processes and opening terminals stays in these few places, so every machine-bound call can be routed
// to another machine later. A new module that needs one goes through a Host instead.
const ALLOWED = new Set(["util.ts", "pty.ts"]);
const SPAWNS = /from ["'](node:)?child_process["']|from ["']node-pty["']|require\(["'](node:)?child_process["']\)/;

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));

describe("machine seams", () => {
  const src = join(import.meta.dirname, "../src");

  it("starts processes only through util, pty and the remote layer", () => {
    const offenders = files(src)
      .map((f) => relative(src, f))
      .filter((f) => !ALLOWED.has(f) && !f.startsWith("remote/") && SPAWNS.test(readFileSync(join(src, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("knows this machine as local", () => {
    expect(listHosts().map((h) => h.id)).toEqual(["local"]);
    expect(hostFor()).toBe(localHost);
    expect(hostFor({ node: "local" })).toBe(localHost);
    expect(() => hostFor({ node: "devbox" })).toThrow(/devbox/);
  });

  it("runs commands and shell lines on this machine", async () => {
    expect((await localHost.exec("echo", ["hi"])).trim()).toBe("hi");
    const chunks: string[] = [];
    const r = await localHost.stream("printf 'a\\nb'", (c) => chunks.push(c));
    expect(r).toEqual({ code: 0, out: "a\nb" });
    expect(chunks.join("")).toBe("a\nb");
    await expect(localHost.exec("false", [])).rejects.toThrow();
  });
});
