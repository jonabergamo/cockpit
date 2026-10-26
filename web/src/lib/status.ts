import type { SessionStatus } from "@cockpit/shared";

// One look per session status, so the strip, the lists and the Board agree. Amber is only for a session that
// asked you something; one that finished its turn is plain grey.
export const statusLook = (status: SessionStatus | undefined, waitingFor?: string, background?: number) => {
  switch (status) {
    case "busy":
      // its turn is over, but shells it started are still going
      if (background) return { label: background > 1 ? `${background} in background` : "in background", hint: `Finished its turn, ${background > 1 ? `${background} shells` : "a shell"} it started still running`, dot: "bg-cobalt", text: "text-cobalt", border: "border-cobalt/50" };
      return { label: "working", hint: "Working", dot: "bg-cobalt", text: "text-cobalt", border: "border-cobalt/50" };
    case "waiting":
      return { label: waitingFor === "input needed" ? "needs your input" : "waiting for you", hint: `Waiting for you${waitingFor ? `: ${waitingFor}` : ""}`, dot: "bg-amber", text: "text-amber", border: "border-amber/50" };
    case "idle":
      return { label: "idle", hint: "Finished its turn", dot: "bg-faint", text: "text-faint", border: "border-line" };
    default:
      return { label: "ended", hint: "", dot: "bg-line", text: "text-faint", border: "border-line" };
  }
};
