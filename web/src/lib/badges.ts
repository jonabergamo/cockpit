import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Badge } from "@cockpit/shared";
import { api } from "./api";
import { useConnected } from "./live";

// The sidebar's badges, by nav id. Fetched once; after that the server pushes them (main.tsx writes the "badges"
// event straight into this query), and they're fetched again when the connection comes back.
export function useBadges() {
  const qc = useQueryClient();
  const connected = useConnected();
  useEffect(() => {
    if (connected) qc.invalidateQueries({ queryKey: ["badges"] });
  }, [connected, qc]);
  return useQuery({ queryKey: ["badges"], queryFn: () => api.get<Record<string, Badge>>("/badges"), staleTime: Infinity }).data ?? {};
}

// for screens with a "since you last looked" count
export const markSeen = (id: string) => api.post<Record<string, Badge>>("/badges/seen", { id }).catch(() => undefined);

// needs you, rather than just busy: what the ☰ button points out on phones
export const needsYou = (b?: Badge) => !!(b?.attention || b?.failed);
