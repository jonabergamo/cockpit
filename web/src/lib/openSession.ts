import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Session } from "@cockpit/shared";
import { api } from "./api";
import { getLiveSessions, send } from "./live";

interface Term {
  id: string;
  pid?: number;
  session?: string;
  exited?: number;
}

// Jumps to the terminal already running a session, or resumes it in a new one.
// claude's pid is the pty's own process, so a session started from cockpit matches either way.
// A prompt is typed into the running session, or passed along when it has to be resumed.
export function useOpenSession() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  return async (s: Pick<Session, "id" | "pid"> & { term?: string }, prompt?: string) => {
    const terms = await qc.fetchQuery({ queryKey: ["terms"], queryFn: () => api.get<Term[]>("/code/terms"), staleTime: 0 });
    const liveS = getLiveSessions().find((l) => l.id === s.id);
    const pid = s.pid ?? liveS?.pid;
    const term = s.term ?? liveS?.term;
    // its own terminal, or the cockpit shell it was started from
    const own = terms.find((t) => t.exited === undefined && (t.session === s.id || (!!pid && t.pid === pid) || t.id === term));
    // the server types into its pane directly, wherever in cockpit's tmux it runs
    if (own && prompt) {
      const { sent } = await api.post<{ sent: boolean }>(`/sessions/${s.id}/send`, { text: prompt });
      if (!sent) {
        // an older claude that doesn't say which pane it's in: type into the terminal itself
        send({ type: "pty.input", id: own.id, data: `\x1b[200~${prompt}\x1b[201~` });
        setTimeout(() => send({ type: "pty.input", id: own.id, data: "\r" }), 200);
      }
    }
    const id = own?.id ?? (await api.post<Term>("/claude/launch", { resume: s.id, prompt })).id;
    if (!own) qc.invalidateQueries({ queryKey: ["terms"] });
    navigate({ to: "/terminals", search: { id } });
  };
}
