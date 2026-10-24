// The run's output as a terminal, for `cockpit run --record` to show beside the browser: a page of its own with
// nothing else on it, reading the run's log as it grows.
export const terminalPage = (id: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>output</title>
<style>
  html, body { margin: 0; height: 100%; background: #0d1117; color: #c9d1d9; overflow: hidden; }
  body { display: flex; flex-direction: column; font: 15px/1.45 "JetBrains Mono", "DejaVu Sans Mono", Menlo, monospace; }
  header { display: flex; gap: 10px; align-items: center; padding: 14px 18px 10px; border-bottom: 1px solid #21262d; color: #e3b341; white-space: nowrap; }
  header .cmd { overflow: hidden; text-overflow: ellipsis; flex: 1; }
  header .state { color: #8b949e; font-size: 13px; }
  header .state.pass { color: #3fb950; } header .state.fail { color: #f85149; }
  main { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; padding: 10px 18px 16px; overflow: hidden; }
  div.l { white-space: pre-wrap; word-break: break-all; min-height: 1.45em; }
  .ok { color: #3fb950; } .bad { color: #f85149; } .note { color: #79c0ff; } .dim { color: #6e7681; }
</style></head>
<body><header><span class="cmd" id="cmd">$</span><span class="state" id="state">running</span></header><main id="out"></main>
<script>
const id = ${JSON.stringify(id)};
const out = document.getElementById("out");
const ansi = /\\x1b\\[[0-9;?]*[A-Za-z]/g;
const kind = (l) =>
  /(✘|✗|×|\\bFAIL(ED)?\\b|\\bfailed\\b|Error:)/.test(l) ? "bad" :
  /(✓|✔|\\bPASS(ED)?\\b|\\bpassed\\b|\\bok\\b)/.test(l) ? "ok" :
  /^\\s*(Running|>|\\$|==)/.test(l) ? "note" : /^\\s*at /.test(l) ? "dim" : "";
let shown = "";
const started = Date.now();
async function tick() {
  try {
    const text = await (await fetch("/api/runs/" + id + "/log", { cache: "no-store" })).text();
    if (text !== shown) {
      shown = text;
      // a line a progress bar redraws in place keeps only its last state
      const lines = text.split("\\n").map((l) => l.split("\\r").pop().replace(ansi, "")).slice(-200);
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      out.replaceChildren(...lines.map((l) => Object.assign(document.createElement("div"), { className: "l " + kind(l), textContent: l })));
    }
  } catch {}
  const s = Math.round((Date.now() - started) / 1000);
  document.getElementById("state").textContent = "● " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  setTimeout(tick, 250);
}
fetch("/api/runs/" + id).then((r) => r.json()).then((r) => {
  const cwd = (r.cwd || "").split("/").filter(Boolean).pop() || "";
  document.getElementById("cmd").textContent = (cwd ? cwd + "  " : "") + "$ " + (r.command || r.name || "");
}).catch(() => {});
tick();
</script></body></html>`;
