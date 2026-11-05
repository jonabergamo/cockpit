import { NodeResizer } from "@xyflow/react";
import { useState, type CSSProperties } from "react";
import { useActions } from "./context";

// Every card but a terminal sizes its height to what it shows, up to max, so a short ticket isn't a tall empty box
// and a long list stops growing at some point and scrolls. Dragging its height yourself fixes it there (dragging
// only its width doesn't); "Fit" in its corner lets it follow its content again.
export function useFit({ id, selected, fit, max, minWidth, minHeight }: { id: string; selected?: boolean; fit?: boolean; max: number; minWidth: number; minHeight: number }) {
  const a = useActions();
  // while you drag it, it fills the box you're drawing
  const [sizing, setSizing] = useState(false);
  const style: CSSProperties = fit && !sizing ? { maxHeight: max } : { height: "100%" };
  const resizer = (
    <>
      <NodeResizer isVisible={selected} minWidth={minWidth} minHeight={minHeight} color="var(--cobalt)" onResizeStart={() => setSizing(true)} onResizeEnd={() => setSizing(false)} />
      {selected && fit === false && (
        <button type="button" onClick={() => a.fit(id)} className="nodrag absolute z-10 bottom-1.5 right-1.5 h-6 px-2 rounded-md border border-line bg-raised text-[12px] text-muted hover:text-ink shadow" title="Let its height follow what it shows again" aria-label="Fit its height to what it shows">
          Fit
        </button>
      )}
    </>
  );
  return { style, resizer };
}
