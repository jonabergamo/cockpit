import type { PluginEvent } from "@cockpit/shared";

// What happens in cockpit that plugins can listen to. Kept free of imports so anything can emit.
const listeners = new Set<(event: PluginEvent, data: unknown) => void>();

export const onEvent = (fn: (event: PluginEvent, data: unknown) => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export function emit(event: PluginEvent, data: unknown) {
  for (const fn of listeners) fn(event, data);
}
