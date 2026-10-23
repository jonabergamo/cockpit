import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { useAppConfig, useJobs } from "../lib/queries";

// The editors repo.openCommand usually calls, by the program's name. The first one found in the command wins,
// so a command that goes through ssh or a wrapper still gets the editor's name.
const editors: Record<string, string> = {
  code: "VS Code",
  "code-insiders": "VS Code",
  codium: "VSCodium",
  cursor: "Cursor",
  windsurf: "Windsurf",
  zed: "Zed",
  subl: "Sublime Text",
  idea: "IntelliJ",
  webstorm: "WebStorm",
  pycharm: "PyCharm",
  fleet: "Fleet",
  nvim: "Neovim",
  vim: "Vim",
  emacs: "Emacs",
  emacsclient: "Emacs",
};

export function editorName(command?: string) {
  for (const word of (command ?? "").split(/[\s"'=]+/)) {
    const name = editors[word.split("/").pop()!];
    if (name) return name;
  }
  return "Editor";
}

export const useEditorName = () => editorName(useAppConfig().data?.openCommand);

// Opens a folder with repo.openCommand. It runs as a job, so `job` holds its output and exit code for a JobLog.
export function useOpenEditor() {
  const jobs = useJobs();
  const label = useEditorName();
  const [jobId, setJobId] = useState<string>();
  const open = useMutation({
    mutationFn: (path: string) => api.post<{ id: string }>("/worktrees/open", { path }),
    onSuccess: (j) => setJobId(j.id),
  });
  return { label, open: (path: string) => open.mutate(path), pending: open.isPending, error: open.error, job: jobs.data?.find((j) => j.id === jobId) };
}
