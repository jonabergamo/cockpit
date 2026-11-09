import { describe, expect, it } from "vitest";
import { parseAdb, parseGpu, parseSims } from "../src/remote/gear.ts";

describe("parseSims", () => {
  it("names the runtime, keeps the available ones and puts the booted first", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ udid: "a", name: "iPhone 15", state: "Shutdown", isAvailable: true }],
        "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
          { udid: "b", name: "iPad Air", state: "Shutdown", isAvailable: true },
          { udid: "c", name: "iPhone 16e", state: "Shutdown", isAvailable: true },
          { udid: "d", name: "iPhone 17", state: "Shutdown", isAvailable: false },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [{ udid: "e", name: "iPhone SE", state: "Booted", isAvailable: true }],
      },
    });
    expect(parseSims(json)!.map((s) => `${s.name} ${s.runtime}${s.booted ? " booted" : ""}`)).toEqual(["iPhone SE iOS 17.5 booted", "iPhone 16e iOS 26.2", "iPad Air iOS 26.2", "iPhone 15 iOS 18.0"]);
  });
});

describe("parseAdb", () => {
  it("tells emulators from phones and reads the model", () => {
    const out = "List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a\n2A281FDH3001Z9         unauthorized usb:1-1 transport_id:3\nR5CT1234               device usb:1-2 product:a54 model:SM_A546B device:a54x\n\n";
    expect(parseAdb(out)).toEqual([
      { serial: "emulator-5554", state: "device", model: "sdk gphone64 arm64", emulator: true },
      { serial: "2A281FDH3001Z9", state: "unauthorized", model: undefined, emulator: false },
      { serial: "R5CT1234", state: "device", model: "SM A546B", emulator: false },
    ]);
  });

  it("has nothing with no devices", () => expect(parseAdb("List of devices attached\n\n")).toEqual([]));
});

describe("parseGpu", () => {
  it("reads the card and says which apps are Ollama and Whisper", () => {
    const g = parseGpu("NVIDIA GeForce RTX 4060, 3, 4686, 8188, 47\n", "874081, /home/u/.local/share/ollama/lib/ollama/llama-server, 4660\n9001, /home/u/.local/share/cockpit-whisper/bin/python, 1500\n12, /usr/bin/Xorg, 40\n")!;
    expect(g).toMatchObject({ name: "NVIDIA GeForce RTX 4060", util: 3, temp: 47 });
    expect(g.memUsed / 1024 / 1024).toBe(4686);
    expect(g.apps.map((a) => [a.name, a.what])).toEqual([
      ["llama-server", "ollama"],
      ["python", "whisper"],
      ["Xorg", undefined],
    ]);
  });

  it("has no GPU without a card line", () => expect(parseGpu("", "")).toBeUndefined());
});
