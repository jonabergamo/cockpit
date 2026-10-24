import type { Machine } from "@cockpit/shared";
import { describe, expect, it } from "vitest";
import { resolve } from "../src/placement/where.ts";

const m = (id: string, state: Machine["state"], gpu = false): Machine => ({ id, name: id, url: `ws://${id}:8771/node`, state, since: 0, info: { hostname: id, platform: "linux-x64", version: "0", terminals: 0, gpu } });

describe("where things run", () => {
  const list = [m("devbox", "up"), m("gpubox", "up", true)];

  it("keeps automations here on a single machine, whatever they're set to", () => {
    expect(resolve("automations", "devbox", list).machine).toBeUndefined();
    expect(resolve("automations", "auto", list).machine).toBeUndefined();
  });

  it("sends transcription to a machine with a GPU on auto", () => {
    expect(resolve("whisper", "auto", list)).toEqual({ machine: "gpubox", why: "gpubox has a GPU" });
    expect(resolve("whisper", "auto", [m("gpubox", "down", true)]).machine).toBeUndefined();
  });

  it("runs one-off work here when the machine it's set to is away or gone", () => {
    expect(resolve("headless", "devbox", list).machine).toBe("devbox");
    expect(resolve("headless", "devbox", [m("devbox", "down")]).machine).toBeUndefined();
    expect(resolve("headless", "oldbox", list).why).toMatch(/isn't a machine any more/);
    expect(resolve("headless", "here", list).machine).toBeUndefined();
  });
});
