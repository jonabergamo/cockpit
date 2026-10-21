import type { Cockpit } from "@cockpit/shared";

interface Note {
  title: string;
  body: string;
  link: string;
  urgent?: boolean;
  kind?: string;
}

// Everything cockpit would show as a browser notification, sent on to a phone.
export default function setup(k: Cockpit) {
  const s = <T>(key: string) => k.setting<T>(key);
  const url = (link: string) => {
    const base = (s<string>("openUrl") ?? "").replace(/\/$/, "");
    return base && link ? (link.startsWith("http") ? link : `${base}${link}`) : undefined;
  };

  async function send(n: Note) {
    const open = url(n.link);
    if (s<string>("service") === "pushover") {
      const token = s<string>("pushoverToken");
      const user = s<string>("pushoverUser");
      if (!token || !user) throw new Error("Set the Pushover app token and user key");
      const form = new URLSearchParams({ token, user, title: n.title, message: n.body || n.title, priority: n.urgent ? "1" : "0", ...(open ? { url: open, url_title: "Open in cockpit" } : {}) });
      const res = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body: form });
      if (!res.ok) throw new Error(`Pushover said ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return;
    }
    const topic = s<string>("ntfyTopic");
    if (!topic) throw new Error("Set an ntfy topic");
    const server = (s<string>("ntfyServer") || "https://ntfy.sh").replace(/\/$/, "");
    const token = s<string>("ntfyToken");
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      body: n.body || n.title,
      headers: {
        // ntfy headers are latin-1, so the title travels encoded
        Title: `=?UTF-8?B?${Buffer.from(n.title).toString("base64")}?=`,
        Priority: n.urgent ? "high" : "default",
        Tags: n.urgent ? "warning" : "robot",
        ...(open ? { Click: open } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`ntfy said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  k.on("notify", (data) => {
    const n = data as Note;
    if (s<boolean>("onlyUrgent") && !n.urgent && !/gave up/i.test(n.title)) return;
    send(n).catch((e) => k.log(`push failed: ${(e as Error).message}`));
  });

  k.route("POST", "/test", async () => {
    await send({ title: "Cockpit test push", body: "If you see this, pushes work.", link: "/board" });
    return { ok: true };
  });
}
