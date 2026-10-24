import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentBox, layout } from "../src/record.ts";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("a recorded run's video", () => {
  it("puts the browser's window and the output side by side, the same height", () => {
    const f = layout({ w: 1281, h: 801, x: 0, y: 0 }, 1000);
    expect(f).toContain("crop=1282:802:0:0,scale=-2:1000");
    expect(f).toContain("[1:v]scale=-2:1000[t]");
    expect(f).toContain("hstack=inputs=2:shortest=1");
  });
  it("is just the output when the browser never showed", () => {
    expect(layout(undefined, 1000)).not.toContain("[0:v]");
  });
  it.skipIf(!hasFfmpeg)("finds the browser's window on an otherwise empty screen", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cockpit-rec-")), "screen.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=black:s=1600x1000:d=2", "-f", "lavfi", "-i", "color=white:s=1280x800:d=2", "-filter_complex", "[0][1]overlay=0:0", "-pix_fmt", "yuv420p", file]);
    expect(await contentBox(file, 1600, 1000)).toEqual({ w: 1280, h: 800, x: 0, y: 0 });
    const blank = file.replace("screen", "blank");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=black:s=1600x1000:d=2", "-pix_fmt", "yuv420p", blank]);
    expect(await contentBox(blank, 1600, 1000)).toBeUndefined();
  });
});
