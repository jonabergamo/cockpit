// Loaded by plugin screens: <script src="/plugin-sdk.js"></script>. Gives the page window.cockpit and keeps it in
// the app's theme. Opened on its own, outside cockpit, the page still works with the default colours.
(() => {
  let host;
  try {
    host = window.parent !== window ? window.parent.cockpitHost : undefined;
  } catch {}
  const plugin = location.pathname.split("/")[2];
  const listeners = [];

  function paint() {
    const t = host?.theme();
    if (!t) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
    root.style.colorScheme = t.scheme;
    root.dataset.scheme = t.scheme;
  }

  // the app's own fonts, so the page looks like the rest of cockpit
  try {
    const rules = [...window.parent.document.styleSheets].flatMap((s) => {
      try {
        return [...s.cssRules].filter((r) => r instanceof window.parent.CSSFontFaceRule).map((r) => r.cssText);
      } catch {
        return [];
      }
    });
    if (rules.length) document.head.append(Object.assign(document.createElement("style"), { textContent: rules.join("\n") }));
  } catch {}

  async function req(url, init = {}) {
    const json = init.body !== undefined && typeof init.body !== "string";
    const res = await fetch(url, { ...init, headers: { ...(json ? { "content-type": "application/json" } : {}), ...init.headers }, body: json ? JSON.stringify(init.body) : init.body });
    const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }

  const go = (to) => (host ? host.navigate(to) : (location.href = to));

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const el = (x) => (typeof x === "string" ? document.querySelector(x) : x);
  const message = (err) => (err && err.message) || String(err ?? "Something went wrong");

  window.cockpit = {
    plugin,
    inCockpit: !!host,
    // your plugin's routes: cockpit.api("/count") calls what k.route("GET", "/count", ...) registered
    api: (path, init) => req(`/api/plugins/${plugin}/x${path.startsWith("/") ? path : `/${path}`}`, init),
    // any of cockpit's own endpoints, e.g. cockpit.core("/sessions?limit=5")
    core: (path, init) => req(`/api${path}`, init),
    navigate: go,
    copy: (text) => (host ? host.copy(text) : navigator.clipboard?.writeText(text)),
    openTerminal: async (opts) => {
      const t = await req("/api/code/terms", { method: "POST", body: opts });
      go(`/terminals?id=${t.id}`);
      return t;
    },
    launchClaude: async (opts) => {
      const t = await req("/api/claude/launch", { method: "POST", body: opts });
      go(`/terminals?id=${t.id}`);
      return t;
    },
    // a terminal to put in an <iframe>, e.g. one your route opened with k.terminal or k.claude
    terminalUrl: (id) => `/embed/terminal/${encodeURIComponent(id)}`,
    // types into a terminal and presses Enter; several lines go in as one paste, so claude gets one message
    typeInto: async (id, text) => {
      await req(`/api/code/terms/${encodeURIComponent(id)}/input`, { method: "POST", body: { data: `\x1b[200~${text}\x1b[201~` } });
      await new Promise((r) => setTimeout(r, 200));
      await req(`/api/code/terms/${encodeURIComponent(id)}/input`, { method: "POST", body: { data: "\r" } });
    },
    // text made safe to put in innerHTML
    esc,
    // shows an error in place of what an element held; el is an element or a selector
    fail: (target, err) => {
      const box = el(target);
      if (!box) return console.error(err);
      box.innerHTML = `<div class="error" role="alert">${esc(message(err))}</div>`;
      return box;
    },
    // skeleton lines in place of what an element held, until you draw into it; text says what's coming
    loading: (target, text = "Loading", rows = 3) => {
      const box = el(target);
      if (box)
        box.innerHTML = `<div class="sdk-loading" role="status" aria-busy="true" aria-label="${esc(text)}"><p class="faint" style="font-size:12px">${esc(text)}</p>${'<div class="sk line"></div>'.repeat(rows)}</div>`;
      return box;
    },
    // a wave over an element while what it shows is about to change; returns it, and on=false stops it
    wave: (target, on = true) => {
      const box = el(target);
      box?.classList.toggle("wave", on);
      return box;
    },
    // Wires a button to fn: it's disabled while fn runs, and a failure shows next to it until the next try.
    // Returns the run, to call it yourself (on load, say) with the same handling.
    refreshButton: (target, fn) => {
      const btn = el(target);
      const run = async (...args) => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.setAttribute("aria-busy", "true");
        btn.classList.add("wave");
        try {
          const out = await fn(...args);
          btn.nextElementSibling?.classList.contains("sdk-fail") && btn.nextElementSibling.remove();
          return out;
        } catch (err) {
          let note = btn.nextElementSibling;
          if (!note?.classList.contains("sdk-fail")) btn.after((note = Object.assign(document.createElement("span"), { className: "sdk-fail", role: "alert" })));
          note.textContent = message(err);
        } finally {
          btn.disabled = false;
          btn.removeAttribute("aria-busy");
          btn.classList.remove("wave");
        }
      };
      btn.onclick = () => run();
      return run;
    },
    // opens a Claude session in a terminal, resuming it if it isn't running
    openSession: (id) => go(`/terminals?resume=${encodeURIComponent(id)}`),
    theme: () => host?.theme(),
    // runs now and on every theme change
    onTheme: (fn) => {
      listeners.push(fn);
      fn(host?.theme());
    },
  };

  paint();
  const off = host?.subscribe(() => {
    paint();
    for (const fn of listeners) fn(host.theme());
  });
  addEventListener("pagehide", () => off?.());
})();
