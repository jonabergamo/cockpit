import { useParams } from "@tanstack/react-router";
import { Terminal } from "./Terminal";

// Just a terminal, no sidebar, for plugin screens to put in a frame: /embed/terminal/<id>
export function EmbedTerminal() {
  const { id } = useParams({ from: "/embed/terminal/$id" });
  return (
    <div className="h-screen w-screen bg-panel">
      <Terminal id={id} onExit={() => window.parent.postMessage({ type: "cockpit:terminal-exit", id }, location.origin)} />
    </div>
  );
}
