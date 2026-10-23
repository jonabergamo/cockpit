import { useEffect, useRef } from "react";
import { useLocation, useParams, useRouter } from "@tanstack/react-router";
import { useAppConfig } from "../lib/queries";
import { Empty, Loading } from "./ui";

// the old link's query goes along, so /p/x/old?doc=a still opens that doc where the screen went
const withQuery = (to: string, query: string) => {
  const q = query.replace(/^\?/, "");
  return q ? `${to}${to.includes("?") ? "&" : "?"}${q}` : to;
};

// A plugin's screen, in a frame on the same origin so it can use the app's API and session. The page's query
// goes along, so a link like /p/meetings/meetings?id=3 opens that meeting.
export function PluginFrame() {
  const { plugin, screen } = useParams({ from: "/p/$plugin/$screen" });
  const query = useLocation({ select: (l) => l.searchStr });
  const router = useRouter();
  const cfg = useAppConfig();
  const s = cfg.data?.screens.find((x) => x.plugin === plugin && x.id === screen);
  const moved = s ? undefined : cfg.data?.moved?.find((x) => x.plugin === plugin && x.id === screen);
  // once: while the router moves, this still renders with the old params and the new query
  const went = useRef("");
  useEffect(() => {
    if (!moved || went.current === `${plugin}/${screen}`) return;
    went.current = `${plugin}/${screen}`;
    void router.navigate({ href: withQuery(moved.to, query), replace: true });
  }, [moved, plugin, screen, query, router]);
  if (cfg.isLoading || moved) return <Loading />;
  if (!s) return <Empty>This screen's plugin is off or removed. Plugins are in Settings.</Empty>;
  const src = withQuery(s.url, query);
  return <iframe key={src} src={src} title={s.title} className="w-full h-full border-0 block" allow="clipboard-write; fullscreen; microphone; display-capture" />;
}
