import { useState } from "react";
import { saveView, savedView, setStripGroup, useStripGroup, type StripGroup, type TermView } from "../lib/canvas";
import { termPrefs, useCopyOnSelect } from "../lib/termPrefs";
import { useSaveSettings, useSettings } from "../lib/cost";
import { Tabs } from "./ui";

// How the Terminals screen shows them, and how they copy, on this device (a phone may want tabs where the desktop
// has the canvas)
export function TerminalSection() {
  const [view, setView] = useState(savedView);
  const copy = useCopyOnSelect();
  const group = useStripGroup();
  const settings = useSettings().data?.settings;
  const save = useSaveSettings();
  const line = settings?.terminals?.statusLine ?? "card";
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
      <div className="flex items-center gap-3 text-[13px]">
        <span className="flex-1 min-w-0">
          <span className="block">Group the cards at the top by</span>
          <span className="block text-[12px] text-faint">{group === "ticket" ? "The ticket each one works on, the rest by workspace once there's more than one." : "The canvas workspace each one is on."}</span>
        </span>
        <Tabs<StripGroup>
          value={group}
          onChange={setStripGroup}
          items={[
            { value: "ticket", label: "Ticket" },
            { value: "workspace", label: "Workspace" },
          ]}
        />
      </div>
      <div className="flex items-center gap-3 text-[13px]">
        <span className="flex-1 min-w-0">
          <span className="block">Claude's status line</span>
          <span className="block text-[12px] text-faint">
            {line === "card" ? "Its model, context, cost, time and lines go along the foot of its card, and the terminal shows none. For every device, from the next Claude you start." : "Claude Code's own, in the terminal, as you set it up in ~/.claude/settings.json. For every device, from the next Claude you start."}
          </span>
        </span>
        <Tabs<"card" | "claude">
          value={line}
          onChange={(v) => void save({ terminals: { statusLine: v } })}
          items={[
            { value: "card", label: "On the card" },
            { value: "claude", label: "In the terminal" },
          ]}
        />
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={copy} onChange={(e) => termPrefs.setCopyOnSelect(e.target.checked)} />
        Copy text as soon as you select it
      </label>
    </section>
  );
}
