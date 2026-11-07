import { useVoice, voice } from "../../lib/voice";

// Across the top of a terminal card while you talk to it: listening, turning it into text, or why that didn't work
export function VoiceStrip({ card }: { card: string }) {
  const v = useVoice();
  if (v.card !== card || v.state === "idle") return null;
  const tone = v.state === "error" ? "bg-red-soft border-red/50 text-red" : "bg-cobalt-soft border-cobalt/40 text-cobalt";
  return (
    <div className={`nodrag flex items-center gap-2 px-2.5 py-1.5 border-b text-[13px] shrink-0 ${tone}`} data-voice={v.state}>
      {v.state === "listening" && (
        <>
          <span className="size-2 rounded-full bg-red animate-pulse shrink-0" />
          <span className="font-medium">Listening</span>
          <span className="text-muted text-[12px] truncate">v or Enter when you're done, Esc to drop it</span>
          <button type="button" onClick={() => voice.stop()} className="ml-auto h-6 px-2 rounded-md bg-cobalt text-on-accent text-[12px] shrink-0">
            Done
          </button>
        </>
      )}
      {v.state === "hearing" && <span>Turning it into text…</span>}
      {v.state === "error" && (
        <>
          <span className="truncate" title={v.error}>
            ⚠ {v.error}
          </span>
          <button type="button" onClick={() => voice.cancel()} className="ml-auto h-6 px-2 rounded-md text-muted hover:text-ink shrink-0">
            OK
          </button>
        </>
      )}
    </div>
  );
}
