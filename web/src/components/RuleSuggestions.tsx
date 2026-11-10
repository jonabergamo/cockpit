import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { RuleSuggestion } from "@cockpit/shared";
import { api } from "../lib/api";
import { useSettings } from "../lib/cost";
import { ago, shortPath } from "../lib/format";
import { Button, ErrorNote } from "./ui";

export const useRuleSuggestions = (enabled = true) => useQuery({ queryKey: ["rule-suggestions"], queryFn: () => api.get<RuleSuggestion[]>("/claude/rules"), enabled, staleTime: 60_000 });

function Row({ s, compact }: { s: RuleSuggestion; compact?: boolean }) {
  const qc = useQueryClient();
  const [said, setSaid] = useState<string>();
  const done = () => qc.invalidateQueries({ queryKey: ["rule-suggestions"] });
  const accept = useMutation({
    mutationFn: (where: "user" | "project") => api.post<{ path: string }>("/claude/rules/accept", { rule: s.rule, where }),
    onSuccess: (r) => (setSaid(`Added to ${shortPath(r.path)}`), setTimeout(done, 1500)),
  });
  const dismiss = useMutation({ mutationFn: () => api.post("/claude/rules/dismiss", { rule: s.rule }), onSuccess: done });
  const busy = accept.isPending || dismiss.isPending || !!said;
  return (
    <div className="px-4 py-2.5 space-y-1.5 text-[13px]">
      <div>
        You've approved <code className="font-mono text-[12px] bg-ground rounded px-1 py-0.5">{s.rule}</code> {s.approvals} times
        <span className="text-faint">, last {ago(s.lastAt)}</span>
      </div>
      {!compact && s.example && <div className="font-mono text-[12px] text-muted truncate" title={s.example}>{s.example}</div>}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => accept.mutate("user")} title="Adds it to permissions.allow in your ~/.claude/settings.json, backed up first">
          Allow everywhere
        </Button>
        {s.project && (
          <Button size="sm" disabled={busy} onClick={() => accept.mutate("project")} title={`Adds it to ${shortPath(s.project)}/.claude/settings.local.json, which is yours and not committed`}>
            Allow in {shortPath(s.project).split("/").pop()}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => dismiss.mutate()} title="Never suggest this rule again">
          Dismiss
        </Button>
        {said && <span className="text-green text-[12px]">{said}</span>}
      </div>
      <ErrorNote error={accept.error ?? dismiss.error} />
    </div>
  );
}

// On Today: the allow rules you keep saying yes to at permission prompts, a few at a time
export function RuleSuggestionsCard() {
  const on = useSettings().data?.settings.ruleSuggestions?.on;
  const q = useRuleSuggestions(!!on);
  const list = q.data ?? [];
  if (!on || (!list.length && !q.error)) return null;
  return (
    <section className="bg-panel border border-line rounded-lg">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="font-semibold flex-1">You always say yes</h2>
        {list.length > 2 && <span className="text-[12px] text-faint">{list.length - 2} more in Settings → Board and automation</span>}
      </div>
      {q.error && (
        <div className="px-4 pb-3">
          <ErrorNote error={q.error} />
        </div>
      )}
      <div className="divide-y divide-line border-t border-line">
        {list.slice(0, 2).map((s) => (
          <Row key={s.rule} s={s} compact />
        ))}
      </div>
    </section>
  );
}

// In Settings: every suggestion, with the full command each was last asked for
export function RuleSuggestionsList({ on }: { on: boolean }) {
  const q = useRuleSuggestions(on);
  if (!on) return null;
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data?.length) return <p className="text-[12px] text-faint">No rule has enough approvals yet.</p>;
  return (
    <div className="border border-line rounded-md divide-y divide-line">
      {q.data.map((s) => (
        <Row key={s.rule} s={s} />
      ))}
    </div>
  );
}
