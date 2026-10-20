import { useParams } from "@tanstack/react-router";
import { useAppConfig } from "../lib/queries";
import { Empty, Loading } from "./ui";

// A plugin's screen, in a frame on the same origin so it can use the app's API and session.
export function PluginFrame() {
  const { plugin, screen } = useParams({ from: "/p/$plugin/$screen" });
  const cfg = useAppConfig();
  if (cfg.isLoading) return <Loading />;
  const s = cfg.data?.screens.find((x) => x.plugin === plugin && x.id === screen);
  if (!s) return <Empty>This screen's plugin is off or removed. Plugins are in Settings.</Empty>;
  return <iframe key={s.url} src={s.url} title={s.title} className="w-full h-full border-0 block" allow="clipboard-write; fullscreen" />;
}
