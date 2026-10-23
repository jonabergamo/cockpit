import type { WebSocket } from "ws";
import type { ServerEvent } from "@cockpit/shared";

export const clients = new Set<WebSocket>();

// for code that follows what the app is told, like the sidebar badges
const taps = new Set<(ev: ServerEvent) => void>();
export const tap = (fn: (ev: ServerEvent) => void) => {
  taps.add(fn);
  return () => void taps.delete(fn);
};

export function send(ws: WebSocket, ev: ServerEvent) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
}

export function broadcast(ev: ServerEvent) {
  const msg = JSON.stringify(ev);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  for (const fn of taps) fn(ev);
}
