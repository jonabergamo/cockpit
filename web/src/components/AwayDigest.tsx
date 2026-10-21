import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { DigestItem } from "@cockpit/shared";
import { api } from "../lib/api";
import { useSettings } from "../lib/cost";
import { ago } from "../lib/format";

const KEY = "cockpit.lastSeen";
const read = () => {
  try {
    return Number(localStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
};
const write = (at: number) => {
  try {
    localStorage.setItem(KEY, String(at));
  } catch {}
};

// When you come back after a while: what finished, what's waiting and what broke while you were gone.
// When you were last here is kept per device, since it's this screen you were away from.
export function AwayDigest() {
  const router = useRouter();
  const minutes = useSettings().data?.settings.away.minutes ?? 30;
  const [since, setSince] = useState<number>();
  useEffect(() => {
    const check = () => {
      const last = read();
      if (document.visibilityState === "visible") {
        if (last && Date.now() - last > minutes * 60_000) setSince(last);
      } else write(Date.now());
    };
    check();
    const bye = () => write(Date.now());
    document.addEventListener("visibilitychange", check);
    addEventListener("pagehide", bye);
    return () => {
      document.removeEventListener("visibilitychange", check);
      removeEventListener("pagehide", bye);
    };
  }, [minutes]);
  const q = useQuery({ queryKey: ["digest", since], queryFn: () => api.get<DigestItem[]>(`/digest?since=${since}`), enabled: !!since });
  const items = q.data ?? [];
  if (!since || !items.length) return null;
  const dismiss = () => {
    write(Date.now());
    setSince(undefined);
  };
  // the same session waiting twice is one thing to know
  const seen = new Set<string>();
  const list = items.filter((i) => {
    const k = `${i.title}|${i.link}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return (
    <section className="bg-panel border border-cobalt/40 rounded-lg">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="font-semibold flex-1">While you were away</h2>
        <span className="text-[12px] text-faint">since {ago(since)}</span>
        <button onClick={dismiss} className="text-[12px] text-cobalt hover:underline">
          Got it
        </button>
      </div>
      <div className="divide-y divide-line max-h-72 overflow-y-auto">
        {list.slice(0, 20).map((i, n) => {
          const body = (
            <>
              <div className="flex items-center gap-2 text-[13px]">
                <span className="truncate flex-1">{i.title}</span>
                <span className="text-[11px] text-faint shrink-0">{ago(i.at)}</span>
              </div>
              {i.body && <div className="text-[12px] text-muted truncate">{i.body}</div>}
            </>
          );
          return i.link?.startsWith("/") ? (
            <button key={n} onClick={() => router.history.push(i.link!)} className="block w-full text-left px-4 py-1.5 hover:bg-ground">
              {body}
            </button>
          ) : (
            <a key={n} href={i.link} target="_blank" rel="noreferrer" className="block px-4 py-1.5 hover:bg-ground">
              {body}
            </a>
          );
        })}
      </div>
    </section>
  );
}
