import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { PullRequest } from "@cockpit/shared";
import { api } from "../lib/api";
import { useOpenSession } from "../lib/openSession";
import { Button } from "./ui";

type Kind = "checks" | "comments";

// Hands a red PR to Claude: into the session that worked on it when there is one, else a new one in its worktree.
export function PrFix({ pr }: { pr: PullRequest }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const openSession = useOpenSession();
  const fix = useMutation({
    mutationFn: async (kind: Kind) => {
      const plan = await api.get<{ prompt: string; sessionId: string | null; cwd: string | null }>(`/prs/${pr.number}/fix?kind=${kind}`);
      if (plan.sessionId) return openSession({ id: plan.sessionId }, plan.prompt);
      if (!plan.cwd) throw new Error(`No worktree for ${pr.branch}, set one up first`);
      const t = await api.post<{ id: string }>("/claude/launch", { cwd: plan.cwd, prompt: plan.prompt, title: `fix #${pr.number}` });
      await qc.invalidateQueries({ queryKey: ["terms"] });
      navigate({ to: "/terminals", search: { id: t.id } });
    },
  });
  if (pr.state !== "OPEN") return null;
  const checks = pr.checks === "fail";
  const comments = pr.reviewDecision === "CHANGES_REQUESTED";
  if (!checks && !comments) return null;

  return (
    <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()} title={fix.error ? String((fix.error as Error).message) : undefined}>
      {checks && (
        <Button size="sm" variant="danger" disabled={fix.isPending} onClick={() => fix.mutate("checks")}>
          {fix.isPending && fix.variables === "checks" ? "Asking Claude" : "Fix checks"}
        </Button>
      )}
      {comments && (
        <Button size="sm" disabled={fix.isPending} onClick={() => fix.mutate("comments")}>
          {fix.isPending && fix.variables === "comments" ? "Asking Claude" : "Address comments"}
        </Button>
      )}
      {fix.error && <span className="text-[12px] text-red self-center">{String((fix.error as Error).message).slice(0, 80)}</span>}
    </span>
  );
}
