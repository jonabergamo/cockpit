// Reloads the page when the server hands out a newer build, so an open window (the desktop app above all) doesn't
// keep showing the old screens after cockpit is updated. It asks when the socket comes back (a restart), when the
// page is shown again, and every few minutes (a rebuild without a restart). It waits until you've stopped typing
// or clicking for a moment, so it never reloads under your hands.
import { onReconnect } from "./live";

// the build this page was loaded from; none in the dev server, where Vite reloads by itself
const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.src.match(/\/assets\/(index-[\w-]+\.js)/)?.[1];

const QUIET_MS = 15_000;
let lastInput = Date.now();
let waiting = false;

function reloadWhenQuiet() {
  if (waiting) return;
  waiting = true;
  const tick = () => {
    // a half-written reply in a box that still has focus would be lost, so that waits for you to send or leave it
    const el = document.activeElement;
    const draft = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.closest(".xterm") && el.value.trim() !== "";
    if (!draft && (document.hidden || Date.now() - lastInput > QUIET_MS)) return location.reload();
    setTimeout(tick, 3000);
  };
  tick();
}

async function check() {
  if (!mine || waiting) return;
  const res = await fetch("/api/version", { cache: "no-store" }).catch(() => undefined);
  const build = res?.ok ? ((await res.json().catch(() => ({}))) as { build?: string }).build : undefined;
  if (build && build !== mine) reloadWhenQuiet();
}

export function watchForUpdates() {
  if (!mine) return;
  for (const ev of ["keydown", "pointerdown", "wheel"]) addEventListener(ev, () => (lastInput = Date.now()), { capture: true, passive: true });
  onReconnect(() => void check());
  document.addEventListener("visibilitychange", () => !document.hidden && void check());
  setInterval(() => void check(), 3 * 60_000);
}
