import type { CanvasNode } from "@cockpit/shared";

// A card and every card linked to it, however far along the lines: what moves with it to another workspace or the
// other screen. The lines are the ones on the board, cockpit's own from a ticket to its terminals among them; cards
// that only show while something runs (a recording's screen) aren't saved, so they stay out.
export function linkedTo(card: string, nodes: Pick<CanvasNode, "id">[], lines: { source: string; target: string }[]) {
  const saved = new Set(nodes.map((n) => n.id));
  const next = new Map<string, string[]>();
  for (const l of lines) {
    if (!saved.has(l.source) || !saved.has(l.target)) continue;
    next.set(l.source, [...(next.get(l.source) ?? []), l.target]);
    next.set(l.target, [...(next.get(l.target) ?? []), l.source]);
  }
  const seen = new Set([card]);
  const todo = [card];
  while (todo.length)
    for (const n of next.get(todo.pop()!) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      todo.push(n);
    }
  return [...seen];
}
