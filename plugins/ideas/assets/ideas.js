// The ideas screen: projects on the left, their ideas in the middle, grouped as you like, and the one you picked
// on the right, with its notes in Markdown.
const $ = (sel, el = document) => el.querySelector(sel);
const esc = cockpit.esc;
const params = new URLSearchParams(location.search);
const saved = (k, v) => {
  try {
    const x = localStorage.getItem(`ideas.${k}`);
    return x === null ? v : JSON.parse(x);
  } catch {
    return v;
  }
};
const keep = (k, v) => {
  try {
    localStorage.setItem(`ideas.${k}`, JSON.stringify(v));
  } catch {}
};

let data = { projects: [], ideas: [], statuses: [] };
let project = params.get("project") ?? saved("project", "all");
let status = saved("status", "open");
let groupBy = saved("groupBy", "group");
let query = "";
let selected = params.get("id") ?? undefined;
let editing = false;

const finished = () => data.statuses.slice(-2);
const stIndex = (s) => Math.max(0, data.statuses.indexOf(s));
const stClass = (s) => `st st-${Math.min(4, Math.round((stIndex(s) / Math.max(1, data.statuses.length - 1)) * 4))}`;
const projName = (id) => data.projects.find((p) => p.id === id)?.name;
const points = (e) => Number(String(e ?? "").match(/([\d.]+)\s*(pts?|points?)\b/i)?.[1] ?? 0);
const md = (t) => (window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(t ?? "", { gfm: true })) : `<pre>${esc(t)}</pre>`);
const refOrder = (r) => {
  const n = parseFloat(String(r ?? "").match(/\d+(\.\d+)?/)?.[0]);
  return isNaN(n) ? -1 : n;
};

async function load() {
  data = await cockpit.api("/data");
  $("#error").innerHTML = "";
  drawProjects();
  drawList();
  drawDetail();
}

// --- projects -------------------------------------------------------------------

function drawProjects() {
  const open = (x) => !finished().includes(x.status);
  const count = (f) => data.ideas.filter((x) => f(x) && open(x)).length;
  const row = (id, name, n) => `<button class="proj ${project === id ? "on" : ""}" data-p="${esc(id)}"><span>${esc(name)}</span><span class="n">${n}</span></button>`;
  $("#projects").innerHTML = `<div class="side-h">Projects</div>
    ${row("all", "All ideas", count(() => true))}
    ${data.projects.map((p) => row(p.id, p.name, count((x) => x.project === p.id))).join("")}
    ${data.ideas.some((x) => !x.project) ? row("none", "No project", count((x) => !x.project)) : ""}
    <button class="small ghost" id="new-project">+ New project</button>`;
  for (const b of document.querySelectorAll("[data-p]")) b.onclick = () => ((project = b.dataset.p), keep("project", project), drawProjects(), drawList(), drawDetail());
  $("#new-project").onclick = async () => {
    const name = prompt("Project name");
    if (!name?.trim()) return;
    try {
      const p = await cockpit.api("/projects", { method: "POST", body: { name } });
      project = p.id;
      keep("project", project);
      await load();
    } catch (e) {
      cockpit.fail("#error", new Error(`Couldn't add the project: ${e.message}`));
    }
  };
  // the quick add goes to the project you're looking at
  $("#cap-project").innerHTML = `<option value="">No project</option>${data.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === project ? "selected" : ""}>${esc(p.name)}</option>`).join("")}`;
}

// --- the list -------------------------------------------------------------------

function shown() {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return data.ideas.filter(
    (x) =>
      (project === "all" || (project === "none" ? !x.project : x.project === project)) &&
      (status === "all" || (status === "open" ? !finished().includes(x.status) : x.status === status)) &&
      words.every((w) => `${x.title} ${x.notes ?? ""} ${x.group ?? ""} ${x.phase ?? ""} ${(x.tags ?? []).join(" ")} ${x.ref ?? ""}`.toLowerCase().includes(w)),
  );
}

function drawList() {
  const list = shown();
  const inProject = data.ideas.filter((x) => project === "all" || (project === "none" ? !x.project : x.project === project));
  const chip = (id, label, n) => `<button class="chip ${status === id ? "on" : ""}" data-s="${esc(id)}">${esc(label)}${n === undefined ? "" : `<b>${n}</b>`}</button>`;
  const key = (x) => (groupBy === "status" ? x.status : groupBy === "phase" ? x.phase || "No phase" : groupBy === "project" ? projName(x.project) || "No project" : groupBy === "group" ? x.group || "Ungrouped" : "");
  const groups = new Map();
  for (const x of list) groups.set(key(x), [...(groups.get(key(x)) ?? []), x]);
  // statuses keep their order; phases sort by their number; groups keep the order they first appear in
  let names = [...groups.keys()];
  if (groupBy === "status") names.sort((a, b) => stIndex(a) - stIndex(b));
  // phases by their number, with the ideas in none at the end
  const last = (g) => (g === "No phase" || refOrder(g) < 0 ? Infinity : refOrder(g));
  if (groupBy === "phase") names.sort((a, b) => last(a) - last(b) || a.localeCompare(b));
  const item = (x) => `<button class="idea ${x.id === selected ? "on" : ""}" data-i="${esc(x.id)}">
      ${x.ref ? `<span class="ref">${esc(x.ref)}</span>` : ""}
      <div class="main"><div class="t">${esc(x.title)}</div>
        <div class="m">${[project === "all" && projName(x.project) ? `<span>${esc(projName(x.project))}</span>` : "", groupBy !== "phase" && x.phase ? `<span>${esc(x.phase)}</span>` : "", x.estimate ? `<span>${esc(x.estimate)}</span>` : "", ...(x.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`)].filter(Boolean).join("")}</div></div>
      ${groupBy === "status" ? "" : `<span class="${stClass(x.status)}">${esc(x.status)}</span>`}
    </button>`;
  $("#list").innerHTML = `
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search ideas" value="${esc(query)}" />
      <select id="group-by" aria-label="Group by">
        ${[["group", "By group"], ["phase", "By phase"], ["status", "By status"], ["project", "By project"], ["none", "No groups"]].map(([v, l]) => `<option value="${v}" ${v === groupBy ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="chips">${chip("open", "Open", inProject.filter((x) => !finished().includes(x.status)).length)}${data.statuses.map((s) => chip(s, s, inProject.filter((x) => x.status === s).length || undefined)).join("")}${chip("all", "All")}</div>
    ${
      list.length
        ? names
            .map((g) => {
              const items = groups.get(g).sort((a, b) => refOrder(a.ref) - refOrder(b.ref) || a.createdAt - b.createdAt);
              const pts = items.reduce((n, x) => n + points(x.estimate), 0);
              return `${groupBy === "none" ? "" : `<div class="group-h"><span>${esc(g)}</span><span class="sum">${items.length}${pts ? ` · ${Math.round(pts * 10) / 10} pts` : ""}</span></div>`}${items.map(item).join("")}`;
            })
            .join("")
        : `<div class="empty">${data.ideas.length ? "Nothing here with these filters." : "No ideas yet. Add one above, or ask Claude to save some."}</div>`
    }`;
  const q = $("#q");
  q.oninput = () => {
    query = q.value;
    const at = q.selectionStart;
    drawList();
    $("#q").focus();
    $("#q").setSelectionRange(at, at);
  };
  $("#group-by").onchange = (e) => ((groupBy = e.target.value), keep("groupBy", groupBy), drawList());
  for (const b of document.querySelectorAll("[data-s]")) b.onclick = () => ((status = b.dataset.s), keep("status", status), drawList());
  for (const b of document.querySelectorAll("[data-i]")) b.onclick = () => ((selected = b.dataset.i), (editing = false), drawList(), drawDetail());
}

// --- one idea, or the project when none is picked ----------------------------------

function drawDetail() {
  const x = data.ideas.find((i) => i.id === selected);
  const box = $("#detail");
  if (!x) {
    const p = data.projects.find((i) => i.id === project);
    if (!p) return (box.innerHTML = `<div class="card empty">Pick an idea to see its notes.</div>`);
    box.innerHTML = `<div class="card proj-card">
      <input class="title-in" id="p-name" value="${esc(p.name)}" aria-label="Project name" />
      <div class="fields">
        <label>About it<input id="p-desc" value="${esc(p.description ?? "")}" placeholder="One line on what this project is" /></label>
        <label>Folder Claude works in<input id="p-folder" value="${esc(p.folder ?? "")}" placeholder="~/code/the-repo" /></label>
      </div>
      <div class="actions"><span class="saved" id="p-saved"></span><span style="flex:1"></span><button class="small ghost" id="p-del">Delete project</button></div>
      <div id="d-err"></div>
      <p class="faint" style="font-size:13px">Pick an idea to see its notes.</p></div>`;
    const put = async (body) => {
      try {
        await cockpit.api(`/projects/${p.id}`, { method: "PUT", body });
        data = await cockpit.api("/data");
      } catch (e) {
        $("#p-saved").textContent = "";
        return cockpit.fail("#d-err", new Error(`Couldn't save it: ${e.message}`));
      }
      $("#p-saved").textContent = "Saved";
      $("#d-err").innerHTML = "";
      drawProjects();
    };
    $("#p-name").onchange = (e) => put({ name: e.target.value });
    $("#p-desc").onchange = (e) => put({ description: e.target.value });
    $("#p-folder").onchange = (e) => put({ folder: e.target.value });
    $("#p-del").onclick = async () => {
      if (!confirm(`Delete ${p.name}? Its ideas stay, without a project.`)) return;
      try {
        await cockpit.api(`/projects/${p.id}`, { method: "DELETE" });
      } catch (e) {
        return cockpit.fail("#d-err", e);
      }
      project = "all";
      keep("project", project);
      load();
    };
    return;
  }
  const opt = (list, cur) => list.map((v) => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
  const groups = [...new Set(data.ideas.filter((i) => i.project === x.project).map((i) => i.group).filter(Boolean))];
  const phases = [...new Set(data.ideas.filter((i) => i.project === x.project).map((i) => i.phase).filter(Boolean))];
  box.innerHTML = `<div class="card">
    <input class="title-in" id="f-title" value="${esc(x.title)}" aria-label="Title" />
    <div class="fields">
      <label>Status<select id="f-status">${opt(data.statuses, x.status)}</select></label>
      <label>Project<select id="f-project"><option value="">No project</option>${data.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === x.project ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
      <label>Group<input id="f-group" list="groups" value="${esc(x.group ?? "")}" /></label>
      <label>Phase<input id="f-phase" list="phases" value="${esc(x.phase ?? "")}" /></label>
      <label>Estimate<input id="f-estimate" value="${esc(x.estimate ?? "")}" placeholder="12 pts" /></label>
      <label>Ref or ticket<input id="f-ref" value="${esc(x.ref ?? "")}" /></label>
      <label style="grid-column:1/-1">Tags<input id="f-tags" value="${esc((x.tags ?? []).join(", "))}" placeholder="comma separated" /></label>
      ${x.source ? `<label style="grid-column:1/-1">From<span style="text-transform:none;letter-spacing:0;font-size:13px">${/^https?:/.test(x.source) ? `<a href="${esc(x.source)}" target="_blank" rel="noreferrer">${esc(x.source)}</a>` : esc(x.source)}</span></label>` : ""}
    </div>
    <datalist id="groups">${groups.map((g) => `<option value="${esc(g)}"></option>`).join("")}</datalist>
    <datalist id="phases">${phases.map((g) => `<option value="${esc(g)}"></option>`).join("")}</datalist>
    <div class="actions">
      <button class="primary small" id="plan">Plan with Claude</button>
      <button class="small" id="edit">${editing ? "Done editing" : "Edit notes"}</button>
      <button class="small" id="copy">Copy</button>
      <span class="saved" id="saved"></span><span style="flex:1"></span>
      <button class="small ghost" id="del">Delete</button>
    </div>
    <div id="d-err"></div>
    ${editing ? `<textarea id="notes" placeholder="Markdown: the problem, the idea, what exists, how to tell it worked">${esc(x.notes ?? "")}</textarea>` : `<div class="md">${x.notes ? md(x.notes) : '<p class="faint">No notes yet.</p>'}</div>`}
  </div>`;
  // a failed save says so under the buttons and leaves what you typed in place; true when it saved
  const put = async (body) => {
    try {
      Object.assign(x, await cockpit.api(`/ideas/${x.id}`, { method: "PUT", body }));
      data = await cockpit.api("/data");
    } catch (e) {
      $("#saved") && ($("#saved").textContent = "");
      $("#d-err") && cockpit.fail("#d-err", new Error(`Couldn't save it: ${e.message}`));
      return false;
    }
    $("#saved") && ($("#saved").textContent = "Saved");
    $("#d-err") && ($("#d-err").innerHTML = "");
    drawProjects();
    drawList();
    return true;
  };
  for (const [id, f] of [["f-title", "title"], ["f-status", "status"], ["f-project", "project"], ["f-group", "group"], ["f-phase", "phase"], ["f-estimate", "estimate"], ["f-ref", "ref"], ["f-tags", "tags"]]) $(`#${id}`).onchange = (e) => put({ [f]: e.target.value });
  let timer;
  const n = $("#notes");
  if (n) n.oninput = () => (clearTimeout(timer), (timer = setTimeout(() => put({ notes: n.value }), 700)));
  $("#edit").onclick = async () => {
    if (editing && n) {
      clearTimeout(timer);
      // the notes stay open when they couldn't be saved
      if (!(await put({ notes: n.value }))) return;
    }
    editing = !editing;
    drawDetail();
  };
  $("#copy").onclick = () => {
    cockpit.copy(`# ${x.title}\n\n${[x.status, x.group, x.phase, x.estimate].filter(Boolean).join(" · ")}\n\n${x.notes ?? ""}`.trim());
    $("#copy").textContent = "Copied";
    setTimeout(() => $("#copy") && ($("#copy").textContent = "Copy"), 1500);
  };
  $("#plan").onclick = async () => {
    try {
      const r = await cockpit.api(`/ideas/${x.id}/plan`, { method: "POST" });
      cockpit.navigate(`/terminals?id=${r.term}`);
    } catch (e) {
      cockpit.fail("#d-err", new Error(`Couldn't start Claude: ${e.message}`));
    }
  };
  $("#del").onclick = async () => {
    if (!confirm(`Delete “${x.title}”?`)) return;
    try {
      await cockpit.api(`/ideas/${x.id}`, { method: "DELETE" });
    } catch (e) {
      return cockpit.fail("#d-err", e);
    }
    selected = undefined;
    load();
  };
  for (const a of box.querySelectorAll(".md a")) (a.target = "_blank"), (a.rel = "noreferrer");
}

$("#capture").onsubmit = async (e) => {
  e.preventDefault();
  const title = $("#cap-title").value.trim();
  if (!title) return;
  let idea;
  try {
    idea = await cockpit.api("/ideas", { method: "POST", body: { title, project: $("#cap-project").value || undefined } });
  } catch (err) {
    return cockpit.fail("#error", new Error(`Couldn't add the idea: ${err.message}`));
  }
  $("#cap-title").value = "";
  selected = idea.id;
  editing = true;
  await load();
  $("#notes")?.focus();
};

// keeps what's on screen when a refresh fails, and says why next to the button
cockpit.refreshButton("#refresh", load);
cockpit.loading("#list");
load().catch((e) => cockpit.fail("#list", e));
