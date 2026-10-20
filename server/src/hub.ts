import type { WebSocket } from "ws";
import type { ServerEvent } from "@cockpit/shared";

export const clients = new Set<WebSocket>();

export function send(ws: WebSocket, ev: ServerEvent) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
}

export function broadcast(ev: ServerEvent) {
  const msg = JSON.stringify(ev);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}
