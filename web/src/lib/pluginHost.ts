import { themeVars } from "@cockpit/shared";
import { copy } from "../components/ui";
import { codeStack, fontStore, uiStack } from "./fonts";
import { themeStore } from "./theme";

// What /plugin-sdk.js reads from inside a plugin's frame, as window.parent.cockpitHost.
export function installPluginHost(navigate: (to: string) => void) {
  const theme = () => {
    const t = themeStore.get().active;
    return { id: t.id, name: t.name, scheme: t.scheme, vars: { ...themeVars(t), "--font-sans": uiStack(fontStore.get()), "--font-mono": codeStack(fontStore.get()) }, ui: t.ui, ansi: t.ansi };
  };
  (window as unknown as { cockpitHost: unknown }).cockpitHost = {
    theme,
    // theme or font changes
    subscribe: (fn: () => void) => {
      const safe = () => {
        // a frame that went away without saying so
        try {
          fn();
        } catch {}
      };
      const offs = [themeStore.subscribe(safe), fontStore.subscribe(safe)];
      return () => offs.forEach((off) => off());
    },
    navigate,
    copy,
  };
}
