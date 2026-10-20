const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function ago(ts?: number | string) {
  if (!ts) return "";
  const t = typeof ts === "string" ? Date.parse(ts) : ts;
  const s = (t - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return new Date(t).toLocaleDateString();
}

export const usd = (n?: number) => (n === undefined || n === null ? "" : n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);

export function bytes(n?: number) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function duration(ms?: number) {
  if (!ms) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// how long until a timestamp, e.g. when a plan window resets
export function until(t?: number) {
  if (!t) return "";
  const m = Math.max(0, Math.round((t - Date.now()) / 60000));
  return m >= 60 * 24 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export const time = (ts: string | number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const shortPath = (p: string) => p.replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");

export const today = () => new Date().toLocaleDateString("en-CA");
