import { createContext, useContext } from "react";
import type { CanvasInfo, CanvasRelay } from "@cockpit/shared";

// what a card on the canvas can ask the board to do
export interface Actions {
  others: CanvasInfo[];
  bringUp: (node: string) => void;
  move: (term: string, to: string) => void;
  close: (term: string) => void;
  openTab: (term: string) => void;
  removeNote: (node: string) => void;
  removeCard: (node: string) => void;
  removeEdge: (edge: string) => void;
  // a line between two terminals relaying turns, or not (null)
  setRelay: (edge: string, relay: CanvasRelay | null) => void;
  // a terminal was just started from a ticket card: it gets a changes card of its own once it's on the canvas
  started: (ticketNode: string, term: string) => void;
  fail: (e: unknown) => void;
}

export const ActionsCtx = createContext<Actions | null>(null);
export const useActions = () => useContext(ActionsCtx)!;

// what a line stands for, from the cards at its ends: a terminal working on a ticket, two terminals, a note, or a
// changes card showing the branch of what it's linked to
export type LinkKind = "work" | "talk" | "note" | "watch";
export interface LinkData extends Record<string, unknown> {
  kind: LinkKind;
  // drawn by cockpit, not by you: the terminal runs in the ticket's worktree
  auto?: boolean;
  // the terminal at one end is working right now
  live?: boolean;
  // between two terminals: passing turns along, how many so far, and what each end is called
  relay?: CanvasRelay;
  hops?: number;
  names?: [string, string];
}
