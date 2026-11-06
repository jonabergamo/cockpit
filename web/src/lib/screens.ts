import type { Viewport } from "@xyflow/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { tabId } from "./canvas";

// One canvas over several screens. A window opened with "Extend to another screen" shows the part of the canvas
// beside the window that opened it, as if their screens were one: the canvas is pinned to the desk, so what runs off
// one window's edge carries on in the other's. The windows (of one browser) share an anchor, a view and where on the
// desk the canvas that had it sat, and each works out its own view from that and where it is itself. Moving either
// window shows another part of the same canvas; panning or zooming in either moves both.

// where the canvas's top-left corner is on the desk, in screen pixels
export type Origin = { x: number; y: number };
export type Anchor = { ws: string; vp: Viewport; origin: Origin };
// what each window shows, for the others to put a card in the middle of it
export type PeerView = { from: string; ws: string; vp: Viewport; origin: Origin; w: number; h: number; at: number };

type Body = { type: "hello" } | { type: "bye" } | { type: "anchor"; anchor: Anchor } | { type: "alive"; view: Omit<PeerView, "from" | "at"> };
type Msg = { group: string; from: string } & Body;

const CHANNEL = "cockpit-canvas-screens";
const ALIVE_MS = 1500;
const GONE_MS = 5000;

export function originOf(el: HTMLElement): Origin {
  const r = el.getBoundingClientRect();
  // the browser's own frame and toolbars sit between the window's corner and the page: what the outer size has over
  // the inner one, split evenly at the sides and the rest on top
  const side = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const top = Math.max(0, window.outerHeight - window.innerHeight - side);
  return { x: window.screenX + side + r.left, y: window.screenY + top + r.top };
}

// the view a window at `at` shows of an anchor: the same zoom, shifted by how far apart the two are on the desk
export const viewFrom = (a: Anchor, at: Origin): Viewport => ({ x: a.vp.x + a.origin.x - at.x, y: a.vp.y + a.origin.y - at.y, zoom: a.vp.zoom });

// the middle of what a window shows, in canvas units
export const middleOf = (p: Pick<PeerView, "vp" | "w" | "h">) => ({ x: (p.w / 2 - p.vp.x) / p.vp.zoom, y: (p.h / 2 - p.vp.y) / p.vp.zoom });

// The group this window leads, the same across its reloads (a tab's own storage), so a window on another screen
// opened from it carries on after you reload this one
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

// The windows a canvas is shown in together. `group` is the window that was extended (its own tab id, for that
// window); a window opened for another screen joins its group.
export function useScreens(opts: {
  group: string;
  wrap: RefObject<HTMLDivElement | null>;
  // what's shown here now, and putting a view (or a workspace) on screen without it counting as you moving it
  current: () => { ws?: string; vp: Viewport };
  show: (ws: string, vp: Viewport) => void;
}) {
  const [peers, setPeers] = useState<PeerView[]>([]);
  const anchor = useRef<Anchor | undefined>(undefined);
  const chan = useRef<BroadcastChannel | null>(null);
  const o = useRef(opts);
  o.current = opts;
  const linked = peers.length > 0;

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const c = new BroadcastChannel(CHANNEL);
    chan.current = c;
    const { group } = o.current;
    const post = (m: Body) => c.postMessage({ ...m, group, from: tabId });
    const seen = new Map<string, PeerView>();
    const update = () => setPeers([...seen.values()].sort((a, b) => a.from.localeCompare(b.from)));
    const alive = () => {
      const el = o.current.wrap.current;
      const cur = o.current.current();
      if (!el || !cur.ws) return;
      const r = el.getBoundingClientRect();
      post({ type: "alive", view: { ws: cur.ws, vp: cur.vp, origin: originOf(el), w: r.width, h: r.height } });
      // the window moved (or went full screen): it shows another part of the same canvas
      const a = anchor.current;
      if (a && a.ws === cur.ws) {
        const next = viewFrom(a, originOf(el));
        if (Math.abs(next.x - cur.vp.x) > 0.5 || Math.abs(next.y - cur.vp.y) > 0.5 || next.zoom !== cur.vp.zoom) o.current.show(a.ws, next);
      }
      for (const [id, p] of seen) if (Date.now() - p.at > GONE_MS) seen.delete(id);
      update();
    };
    c.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      if (!m || m.group !== group || m.from === tabId) return;
      if (m.type === "hello") {
        // someone new: it takes the view from here
        seen.set(m.from, { from: m.from, ws: "", vp: { x: 0, y: 0, zoom: 1 }, origin: { x: 0, y: 0 }, w: 0, h: 0, at: Date.now() });
        update();
        const el = o.current.wrap.current;
        const cur = o.current.current();
        if (el && cur.ws) post({ type: "anchor", anchor: anchor.current?.ws === cur.ws ? anchor.current : { ws: cur.ws, vp: cur.vp, origin: originOf(el) } });
      } else if (m.type === "bye") {
        seen.delete(m.from);
        update();
      } else if (m.type === "alive") {
        seen.set(m.from, { ...m.view, from: m.from, at: Date.now() });
        update();
      } else if (m.type === "anchor") {
        anchor.current = m.anchor;
        const el = o.current.wrap.current;
        if (el) o.current.show(m.anchor.ws, viewFrom(m.anchor, originOf(el)));
      }
    };
    post({ type: "hello" });
    const timer = setInterval(alive, ALIVE_MS);
    const bye = () => post({ type: "bye" });
    window.addEventListener("pagehide", bye);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", bye);
      bye();
      c.close();
      chan.current = null;
    };
  }, []);

  // You moved the canvas here (or it was framed on a card): the others follow. Only while there are others.
  const moved = (ws: string, vp: Viewport) => {
    const el = opts.wrap.current;
    if (!el || !chan.current) return;
    anchor.current = { ws, vp, origin: originOf(el) };
    if (linked) chan.current.postMessage({ type: "anchor", anchor: anchor.current, group: opts.group, from: tabId } satisfies Msg);
  };
  // whether another window has said what to show, so this one doesn't pick a view of its own
  const anchored = () => !!anchor.current;
  // what another window shows right now: what it said last, moved on by whatever was panned since
  const viewOf = (p: PeerView): PeerView => (anchor.current?.ws === p.ws ? { ...p, vp: viewFrom(anchor.current, p.origin) } : p);
  return { peers, linked, moved, anchored, viewOf };
}
