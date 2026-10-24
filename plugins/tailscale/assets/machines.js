const esc = cockpit.esc;
let machines = [];

const known = (p) => machines.find((m) => [p.name, p.dns, p.ip].filter(Boolean).some((a) => m.url.includes(`//${a}:`)));

async function peers() {
  const box = document.querySelector("#peers");
  try {
    const [list, ms] = await Promise.all([cockpit.api("/peers"), cockpit.core("/machines")]);
    machines = ms.machines;
    box.classList.remove("sdk-loading");
    box.innerHTML = list
      .map((p, i) => {
        const m = known(p);
        const action = p.self ? '<span class="tag">this machine</span>' : m ? `<span class="tag">added as ${esc(m.name)} · ${esc(m.state)}</span>` : `<button data-add="${i}" ${p.online ? "" : "disabled"}>Add as node</button>`;
        return `<div class="peer"><div class="who"><span class="dot ${p.online ? "on" : ""}"></span><b>${esc(p.name)}</b> <span class="faint">${esc(p.os)}</span><div class="muted" style="font-size:12px">${esc(p.dns || p.ip)}</div></div>${action}</div>`;
      })
      .join("");
    box.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => add(list[Number(b.dataset.add)])));
  } catch (e) {
    box.classList.remove("sdk-loading");
    box.innerHTML = `<div class="error">Couldn't read the tailnet: ${esc(e.message)}</div>`;
  }
}

async function add(p) {
  const out = document.querySelector("#pairing");
  try {
    const r = await cockpit.core("/machines", { method: "POST", body: { name: p.name, address: p.dns || p.ip } });
    out.innerHTML = `<div class="card"><h2>Pair ${esc(p.name)}</h2><p class="muted">Run <code>cockpit node</code> on it, then this. Keep it to yourself, it's the node's key to this hub.</p><pre class="pair">${esc(r.pair)}</pre><button class="primary" id="copy">Copy</button></div>`;
    document.querySelector("#copy").onclick = () => navigator.clipboard?.writeText(r.pair);
    await Promise.all([peers(), placement()]);
  } catch (e) {
    out.innerHTML = `<div class="error">Couldn't add ${esc(p.name)}: ${esc(e.message)}</div>`;
  }
}

async function placement() {
  const box = document.querySelector("#placement");
  const caps = await cockpit.core("/machines/placement");
  const name = (id) => (id === "here" ? "this machine" : (machines.find((m) => m.id === id)?.name ?? id));
  box.classList.remove("sdk-loading");
  box.innerHTML = caps
    .map(
      (c) => `<div class="place"><div class="what"><b>${esc(c.label)}</b><div class="muted" style="font-size:12px">${esc(c.help)}</div></div><div><select data-cap="${esc(c.id)}">
        <option value="auto" ${c.value === "auto" ? "selected" : ""}>Auto (${esc(name(c.runs))})</option>
        <option value="here" ${c.value === "here" ? "selected" : ""}>This machine</option>
        ${c.options.map((id) => `<option value="${esc(id)}" ${c.value === id ? "selected" : ""}>${esc(name(id))}</option>`).join("")}
      </select><div class="faint" style="font-size:11px">${esc(c.why)}</div></div></div>`,
    )
    .join("");
  box.querySelectorAll("select").forEach(
    (s) =>
      (s.onchange = async () => {
        await cockpit.core("/machines/placement", { method: "PUT", body: { cap: s.dataset.cap, value: s.value } });
        placement();
      }),
  );
}

peers().then(placement);
