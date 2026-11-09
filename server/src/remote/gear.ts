// What this machine has for testing apps and for local models: iOS simulators and paired iPhones (Xcode), Android
// emulators and phones (the Android SDK), the NVIDIA GPU and what holds it, Ollama's loaded models and Whisper.
// Read on demand and kept for a few seconds, since devicectl alone takes a few. Every part is optional: a tool
// that isn't installed leaves its part out, it never fails the rest.
import type { Gear, GearAction } from "@cockpit/shared";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { quickStatsHere } from "../quick.ts";
import { getSettings } from "../settings.ts";
import { run } from "../util.ts";

const KEEP_MS = 10_000;
let cached: { at: number; p: Promise<Gear> } | undefined;

// the SDK isn't on the PATH of an app started from the Dock, so look where Android Studio puts it too
function sdkTool(dir: "platform-tools" | "emulator", name: string) {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library/Android/sdk"), join(homedir(), "Android/Sdk")].filter(Boolean) as string[];
  for (const r of roots) if (existsSync(join(r, dir, name))) return join(r, dir, name);
  return name;
}
const adb = () => sdkTool("platform-tools", "adb");
const emulator = () => sdkTool("emulator", "emulator");
const whisperPython = () => (process.env.COCKPIT_WHISPER_PYTHON ?? "~/.local/share/cockpit-whisper/bin/python").replace(/^~/, homedir());

const quiet = <T>(p: Promise<T>) => p.catch(() => undefined);

// `xcrun simctl list devices available -j`
export function parseSims(json: string): Gear["sims"] {
  const d = JSON.parse(json) as { devices: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]> };
  const out = Object.entries(d.devices).flatMap(([rt, list]) => {
    const runtime = rt.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1");
    return list.filter((s) => s.isAvailable !== false).map((s) => ({ udid: s.udid, name: s.name, runtime, booted: s.state === "Booted" }));
  });
  // booted first, then the newest runtime, iPhones before iPads
  return out.sort((a, b) => Number(b.booted) - Number(a.booted) || b.runtime.localeCompare(a.runtime, undefined, { numeric: true }) || Number(a.name.includes("iPad")) - Number(b.name.includes("iPad")) || a.name.localeCompare(b.name));
}

// `adb devices -l`: emulators are emulator-NNNN, the rest are phones
export function parseAdb(out: string) {
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      const model = /model:(\S+)/.exec(l)?.[1]?.replace(/_/g, " ");
      return { serial, state, model, emulator: serial.startsWith("emulator-") };
    });
}

// `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` and the compute apps the same way
export function parseGpu(gpuCsv: string, appsCsv: string): Gear["gpu"] {
  const line = gpuCsv.split("\n").find((l) => l.trim());
  if (!line) return undefined;
  const [name, util, used, total, temp] = line.split(",").map((s) => s.trim());
  const MB = 1024 * 1024;
  const apps = appsCsv
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [pid, path, mem] = l.split(",").map((s) => s.trim());
      const what = /ollama/i.test(path) ? ("ollama" as const) : /whisper|transcribe/i.test(path) ? ("whisper" as const) : undefined;
      return { pid: Number(pid), name: path.split("/").pop() ?? path, mem: Number(mem) * MB, what };
    });
  return { name, util: Number(util), memUsed: Number(used) * MB, memTotal: Number(total) * MB, temp: temp && !Number.isNaN(Number(temp)) ? Number(temp) : undefined, apps };
}

// the AVD an emulator runs, which `adb emu avd name` answers with the name then OK
const avdOf = (serial: string) => quiet(run(adb(), ["-s", serial, "emu", "avd", "name"], { timeout: 3000 }).then((o) => o.split("\n")[0].trim()));

async function iphones(): Promise<NonNullable<Gear["phones"]>> {
  const file = join(tmpdir(), `cockpit-devicectl-${process.pid}.json`);
  try {
    await run("xcrun", ["devicectl", "list", "devices", "--json-output", file, "-q"], { timeout: 15_000 });
    const d = JSON.parse(readFileSync(file, "utf8")) as { result?: { devices?: any[] } };
    return (d.result?.devices ?? [])
      .filter((x) => x.hardwareProperties?.deviceType === "iPhone" || x.hardwareProperties?.deviceType === "iPad")
      .map((x) => ({ id: String(x.hardwareProperties?.udid ?? x.identifier), name: String(x.deviceProperties?.name ?? "iPhone"), kind: "ios" as const, connected: x.connectionProperties?.tunnelState === "connected" }));
  } catch {
    return [];
  } finally {
    rmSync(file, { force: true });
  }
}

async function apple(g: Gear) {
  const [sims, phones] = await Promise.all([quiet(run("xcrun", ["simctl", "list", "devices", "available", "-j"], { timeout: 10_000 }).then(parseSims)), iphones()]);
  if (sims) g.sims = sims;
  if (phones.length) g.phones = [...(g.phones ?? []), ...phones];
}

async function android(g: Gear) {
  const [devices, avds] = await Promise.all([
    quiet(run(adb(), ["devices", "-l"], { timeout: 5000 }).then(parseAdb)),
    quiet(run(emulator(), ["-list-avds"], { timeout: 5000 }).then((o) => o.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("INFO"))))
  ]);
  if (!devices && !avds) return;
  const running = await Promise.all((devices ?? []).filter((d) => d.emulator).map(async (d) => ({ serial: d.serial, avd: await avdOf(d.serial) })));
  g.avds = (avds ?? []).map((name) => ({ name, serial: running.find((r) => r.avd === name)?.serial }));
  // an emulator whose AVD isn't in the list (started from elsewhere) still shows
  for (const r of running) if (!g.avds.some((a) => a.serial === r.serial)) g.avds.push({ name: r.avd || r.serial, serial: r.serial });
  const phones = (devices ?? []).filter((d) => !d.emulator).map((d) => ({ id: d.serial, name: d.model ?? d.serial, kind: "android" as const, connected: d.state === "device" }));
  if (phones.length) g.phones = [...(g.phones ?? []), ...phones];
}

async function gpu(g: Gear) {
  const [cards, apps] = await Promise.all([
    quiet(run("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"], { timeout: 5000 })),
    quiet(run("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"], { timeout: 5000 })),
  ]);
  if (cards) g.gpu = parseGpu(cards, apps ?? "");
}

async function models(g: Gear) {
  const stats = quickStatsHere();
  const url = (stats.url ?? getSettings().quick.url).replace(/\/$/, "");
  const model = stats.model ?? getSettings().quick.model;
  const ps = await quiet(
    fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? (r.json() as Promise<{ models?: { name: string; size: number; size_vram?: number; expires_at?: string }[] }>) : undefined)),
  );
  // nothing to say on a machine without Ollama and without a quick model
  if (!ps && !model) return;
  const loaded = (ps?.models ?? []).map((m) => ({ name: m.name, size: m.size, vram: m.size_vram ?? 0, until: m.expires_at }));
  g.ollama = {
    up: !!ps,
    url,
    loaded,
    quick: model ? { model, loaded: loaded.some((m) => m.name === model || m.name === `${model}:latest`), lastMs: stats.lastMs, avgMs: stats.avgMs, at: stats.at, failed: stats.failed || undefined } : undefined,
  };
}

async function whisper(g: Gear) {
  const installed = existsSync(whisperPython());
  const onGpu = g.gpu?.apps.some((a) => a.what === "whisper");
  const running = onGpu || !!(await quiet(run("pgrep", ["-f", "transcribe.py"], { timeout: 3000 })))?.trim();
  if (installed || running) g.whisper = { installed, running };
}

async function read(): Promise<Gear> {
  const g: Gear = { at: Date.now() };
  await Promise.all([process.platform === "darwin" ? apple(g) : undefined, android(g), gpu(g)]);
  await Promise.all([models(g), whisper(g)]);
  return g;
}

export function gearHere(fresh = false): Promise<Gear> {
  if (!fresh && cached && Date.now() - cached.at < KEEP_MS) return cached.p;
  const p = read();
  cached = { at: Date.now(), p };
  p.catch(() => (cached = undefined));
  return p;
}

// an emulator keeps running after the request that started it, and outlives a cockpit restart
function detached(cmd: string, args: string[]) {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export async function gearAct(a: GearAction): Promise<Gear> {
  const need = (v: unknown, what: string) => {
    if (typeof v !== "string" || !v.trim()) throw Object.assign(new Error(`Say which ${what}`), { status: 400 });
    return v.trim();
  };
  switch (a.do) {
    case "sim.boot":
      // already booted is fine; the Simulator app is what shows it
      await run("xcrun", ["simctl", "boot", need(a.udid, "simulator")], { timeout: 60_000 }).catch((e: Error) => {
        if (!/current state: Booted/i.test(e.message)) throw e;
      });
      await quiet(run("open", ["-a", "Simulator"], { timeout: 10_000 }));
      break;
    case "sim.shutdown":
      await run("xcrun", ["simctl", "shutdown", need(a.udid, "simulator")], { timeout: 30_000 });
      break;
    case "sim.install":
      await run("xcrun", ["simctl", "install", need(a.udid, "simulator"), need(a.path, "build (.app)").replace(/^~/, homedir())], { timeout: 120_000 });
      break;
    case "avd.start":
      detached(emulator(), ["-avd", need(a.name, "emulator")]);
      break;
    case "avd.stop":
      await run(adb(), ["-s", need(a.serial, "emulator"), "emu", "kill"], { timeout: 15_000 });
      break;
    case "apk.install":
      await run(adb(), ["-s", need(a.serial, "device"), "install", "-r", need(a.path, "build (.apk)").replace(/^~/, homedir())], { timeout: 180_000 });
      break;
    default:
      throw Object.assign(new Error("Not something cockpit can do to a device"), { status: 400 });
  }
  // what it looks like now; a booting emulator shows up on a later read
  return gearHere(true);
}
