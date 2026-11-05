import { useState } from "react";
import { saveView, savedView, type TermView } from "../lib/canvas";
import { termPrefs, useCopyOnSelect } from "../lib/termPrefs";
import { Tabs } from "./ui";

// How the Terminals screen shows them, and how they copy, on this device (a phone may want tabs where the desktop
// has the canvas)
export function TerminalSection() {
  const [view, setView] = useState(savedView);
  const copy = useCopyOnSelect();
  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div>
        <h2 className="font-semibold">Terminals</h2>
        <p className="text-[13px] text-muted mt-0.5">How the Terminals screen shows them, on this device.</p>
      </div>
      <Tabs<TermView>
        value={view}
        onChange={(v) => {
          saveView(v);
          setView(v);
        }}
        items={[
          { value: "canvas", label: "Canvas" },
          { value: "tabs", label: "Tabs" },
        ]}
      />
      <p className="text-[13px] text-muted">{view === "canvas" ? "Every terminal on a canvas you arrange, with its ticket, notes, changes and runs, in workspaces. A card at the top takes you to its terminal there." : "One terminal at a time, with its changes beside it. The cards at the top are its tabs."}</p>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={copy} onChange={(e) => termPrefs.setCopyOnSelect(e.target.checked)} />
        Copy text as soon as you select it
      </label>
    </section>
  );
}
