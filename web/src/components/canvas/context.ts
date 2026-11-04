import { createContext, useContext } from "react";
import type { CanvasInfo } from "@cockpit/shared";

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
  fail: (e: unknown) => void;
}

export const ActionsCtx = createContext<Actions | null>(null);
export const useActions = () => useContext(ActionsCtx)!;

// what a line stands for, from the cards at its ends: a terminal working on a ticket, two terminals, or a note
export type LinkKind = "work" | "talk" | "note";
export interface LinkData extends Record<string, unknown> {
  kind: LinkKind;
  // drawn by cockpit, not by you: the terminal runs in the ticket's worktree
  auto?: boolean;
  // the terminal at one end is working right now
  live?: boolean;
}
