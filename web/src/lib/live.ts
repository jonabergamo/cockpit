import { useEffect, useSyncExternalStore } from "react";
import type { ClientEvent, ServerEvent, Session } from "@cockpit/shared";

type Listener = (ev: ServerEvent) => void;

const listeners = new Set<Listener>();
const watches = new Map<string, ClientEvent>();
let ws: WebSocket | null = null;
let retry = 500;
let connected = false;
const connListeners = new Set<() => void>();

let liveSessions: Session[] = [];
const sessionListeners = new Set<() => void>();

function setConnected(v: boolean) {
  connected = v;
  connListeners.forEach((l) => l());
}

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 500;
    setConnected(true);
    for (const w of watches.values()) ws!.send(JSON.stringify(w));
  };
  ws.onmessage = (m) => {
    const ev: ServerEvent = JSON.parse(m.data);
    if (ev.type === "sessions") {
      liveSessions = ev.sessions;
      sessionListeners.forEach((l) => l());
    }
    listeners.forEach((l) => l(ev));
  };
  ws.onclose = () => {
    setConnected(false);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
}

connect();

export const getLiveSessions = () => liveSessions;

// for code outside React, like the query cache, that wants every event
export function listen(fn: Listener) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function send(ev: ClientEvent) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
}

// Watches are replayed after a reconnect so live views keep streaming.
export function keep(key: string, ev: ClientEvent | null) {
  if (ev) {
    watches.set(key, ev);
    send(ev);
  } else watches.delete(key);
}

export function useLive(fn: Listener, deps: unknown[] = []) {
  useEffect(() => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export const useConnected = () =>
  useSyncExternalStore(
    (cb) => (connListeners.add(cb), () => void connListeners.delete(cb)),
    () => connected,
  );

export const useLiveSessions = () =>
  useSyncExternalStore(
    (cb) => (sessionListeners.add(cb), () => void sessionListeners.delete(cb)),
    () => liveSessions,
  );
