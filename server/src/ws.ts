import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientEvent } from "@cockpit/shared";
import { allowed } from "./auth.ts";
import { demo } from "./config.ts";
import { demoSessions } from "./demo.ts";
import { agentFile, listSessions, sessionFile } from "./claude/sessions.ts";
import { parseLine, readFrom } from "./claude/transcript.ts";
import { clients, send } from "./hub.ts";
import * as term from "./pty.ts";

interface Sub {
  sessionId: string;
  agentId?: string;
  file: string;
  offset: number;
  busy: boolean;
}

const subs = new Map<WebSocket, Map<string, Sub>>();

export const wss = new WebSocketServer({ noServer: true });

export function canUpgrade(req: IncomingMessage) {
  return allowed(req.headers, req.socket.remoteAddress);
}

wss.on("connection", (ws) => {
  clients.add(ws);
  subs.set(ws, new Map());
  send(ws, { type: "sessions", sessions: demo ? demoSessions() : listSessions({ liveOnly: true }) });
  send(ws, { type: "terms", terms: term.listTerms() });

  ws.on("message", async (raw) => {
    let ev: ClientEvent;
    try {
      ev = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const mine = subs.get(ws)!;
    switch (ev.type) {
      case "watch": {
        const file = ev.agentId ? await agentFile(ev.sessionId, ev.agentId) : sessionFile(ev.sessionId);
        if (file) mine.set(`${ev.sessionId}/${ev.agentId ?? ""}`, { sessionId: ev.sessionId, agentId: ev.agentId, file, offset: ev.offset, busy: false });
        break;
      }
      case "unwatch":
        mine.delete(`${ev.sessionId}/${ev.agentId ?? ""}`);
        break;
      case "pty.attach":
        term.attach(ws, ev.id);
        break;
      case "pty.input":
        term.input(ev.id, ev.data);
        break;
      case "pty.search":
        term.search(ev.id, ev.query, ev.step);
        break;
      case "pty.scroll":
        term.scroll(ev.id, ev.lines);
        break;
      case "pty.resize":
        term.resize(ev.id, ev.cols, ev.rows);
        break;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    subs.delete(ws);
    term.detachAll(ws);
  });
});

setInterval(async () => {
  for (const [ws, mine] of subs) {
    for (const sub of mine.values()) {
      if (sub.busy) continue;
      sub.busy = true;
      try {
        const chunk = await readFrom(sub.file, sub.offset);
        sub.offset = chunk.offset;
        const entries = chunk.lines.flatMap((l) => parseLine(l));
        if (entries.length) send(ws, { type: "entries", sessionId: sub.sessionId, agentId: sub.agentId, entries });
      } catch {
        // file rotated or removed
      } finally {
        sub.busy = false;
      }
    }
  }
}, 700);
