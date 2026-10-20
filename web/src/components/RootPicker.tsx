import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { shortPath } from "../lib/format";
import { inputClass } from "./ui";

export interface Roots {
  worktrees: { path: string; name: string; branch?: string; ticket?: string }[];
  projects: string[];
  folders: string[];
}

export const useRoots = () => useQuery({ queryKey: ["roots"], queryFn: () => api.get<Roots>("/code/roots") });

export function RootPicker({ value, onChange, className = "" }: { value: string; onChange: (v: string) => void; className?: string }) {
  const roots = useRoots();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} w-full ${className}`}>
      <option value="">Pick a worktree or project</option>
      <optgroup label="Worktrees">
        {roots.data?.worktrees.map((w) => (
          <option key={w.path} value={w.path}>
            {w.name}
            {w.branch ? ` (${w.branch})` : ""}
          </option>
        ))}
      </optgroup>
      <optgroup label="Projects">
        {roots.data?.projects.map((p) => (
          <option key={p} value={p}>
            {shortPath(p)}
          </option>
        ))}
      </optgroup>
      {!!roots.data?.folders.length && (
        <optgroup label="Saved">
          {roots.data.folders.map((p) => (
            <option key={p} value={p}>
              {shortPath(p)}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
