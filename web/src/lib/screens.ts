import type { Viewport } from "@xyflow/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { tabId } from "./canvas";

// The canvas on more than one screen. A window opened with "Another screen" is a canvas of its own, with its own
// workspace, place and zoom; the windows (of one browser) only tell each other what they show, so a card and all
// that's linked to it can be sent to the middle of what the other one shows.

// what each window shows
export type PeerView = { from: string; ws: string; vp: Viewport; w: number; h: number; at: number };

type Body = { type: "hello" } | { type: "bye" } | { type: "alive"; view: Omit<PeerView, "from" | "at"> };
type Msg = { group: string; from: string } & Body;

const CHANNEL = "cockpit-canvas-screens";
const ALIVE_MS = 2000;
const GONE_MS = 6000;

// the middle of what a window shows, in canvas units
export const middleOf = (p: Pick<PeerView, "vp" | "w" | "h">) => ({ x: (p.w / 2 - p.vp.x) / p.vp.zoom, y: (p.h / 2 - p.vp.y) / p.vp.zoom });

// The windows of one group are the screens of one desk: the main window's, the same across its reloads (a tab's own
// storage), and those opened from it
export function screenGroup() {
  try {
    const had = sessionStorage.getItem("cockpit.screenGroup");
    if (had) return had;
    const id = Math.random().toString(36).slice(2);
    sessionStorage.setItem("cockpit.screenGroup", id);
    return id;
  } catch {
    return tabId;
  }
}

// Opens a window for another screen, on the screen this one isn't on when the browser can say where they are (Chrome
// asks once), or else one you drag there.
export async function openScreen(group: string) {
  const url = `${location.origin}/embed/canvas?group=${encodeURIComponent(group)}`;
  let features = "popup,width=900,height=1200";
  try {
    const w = window as Window & { getScreenDetails?: () => Promise<{ screens: ScreenArea[]; currentScreen: ScreenArea }> };
    if (w.getScreenDetails) {
      const d = await w.getScreenDetails();
      const other = d.screens.find((s) => s !== d.currentScreen && (s.availLeft !== d.currentScreen.availLeft || s.availTop !== d.currentScreen.availTop));
      if (other) features = `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
    }
  } catch {}
  return window.open(url, `cockpit-screen-${group}-${Date.now()}`, features);
}
type ScreenArea = { availLeft: number; availTop: number; availWidth: number; availHeight: number };

// The other windows of this group and what each shows, the latest heard first; `announce` says what this one shows
// now (after you move it, or switch workspace)
export function useScreens(opts: { group: string; wrap: RefObject<HTMLDivElement | null>; current: () => { ws?: string; vp: Viewport } }) {
  const [peers, setPeers] = useState<PeerView[]>([]);
  const post = useRef<(m: Body) => void>(() => {});
  const o = useRef(opts);
  useEffect(() => {
    o.current = opts;
  });

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const c = new BroadcastChannel(CHANNEL);
    const { group } = o.current;
    post.current = (m) => c.postMessage({ ...m, group, from: tabId } satisfies Msg);
    const seen = new Map<string, PeerView>();
    const update = () => setPeers([...seen.values()].sort((a, b) => b.at - a.at));
    const alive = () => {
      const el = o.current.wrap.current;
      const cur = o.current.current();
      if (!el || !cur.ws) return;
      const r = el.getBoundingClientRect();
      post.current({ type: "alive", view: { ws: cur.ws, vp: cur.vp, w: r.width, h: r.height } });
    };
    const sweep = () => {
      for (const [id, p] of seen) if (Date.now() - p.at > GONE_MS) seen.delete(id);
      update();
    };
    c.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      if (!m || m.group !== group || m.from === tabId) return;
      if (m.type === "hello") return alive();
      if (m.type === "bye") seen.delete(m.from);
      else seen.set(m.from, { ...m.view, from: m.from, at: Date.now() });
      update();
    };
    post.current({ type: "hello" });
    const timer = setInterval(() => (alive(), sweep()), ALIVE_MS);
    const bye = () => post.current({ type: "bye" });
    window.addEventListener("pagehide", bye);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", bye);
      bye();
      c.close();
      post.current = () => {};
    };
  }, []);

  const announce = () => {
    const el = o.current.wrap.current;
    const cur = o.current.current();
    if (!el || !cur.ws) return;
    const r = el.getBoundingClientRect();
    post.current({ type: "alive", view: { ws: cur.ws, vp: cur.vp, w: r.width, h: r.height } });
  };
  return { peers, linked: peers.length > 0, announce };
}
