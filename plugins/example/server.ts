import type { Cockpit } from "@cockpit/shared";

export default function setup(k: Cockpit) {
  k.screen({ id: "hello", title: "Example", page: "assets/index.html" });

  k.route("GET", "/count", () => ({ count: k.store.get<number>("count") ?? 0, greeting: k.setting("greeting") }));
  k.route("POST", "/count", () => {
    const count = (k.store.get<number>("count") ?? 0) + 1;
    k.store.set("count", count);
    return { count };
  });

  k.on("session.idle", (s) => k.log("a session is waiting:", (s as { title?: string }).title ?? "untitled"));
}
