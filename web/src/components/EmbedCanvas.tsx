import { useSearch } from "@tanstack/react-router";
import { TermCanvas } from "./TermCanvas";

// The canvas on another screen, carrying on from the window that opened it: /embed/canvas?group=<that window>
export function EmbedCanvas() {
  const { group } = useSearch({ from: "/embed/canvas" });
  return (
    <div className="h-screen w-screen flex flex-col bg-ground">
      <TermCanvas switcher={null} screen={group ?? "main"} />
    </div>
  );
}
