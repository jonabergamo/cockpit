// The meetings screen: record one (your mic, and the computer's sound when the meeting is on this computer),
// import or paste one, then read Claude's write-up, jump around the recording and ask about it.
const $ = (sel, el = document) => el.querySelector(sel);
const esc = cockpit.esc;
const error = (e) => `<div class="error" role="alert">${esc(e.message ?? e)}</div>`;
const clock = (s) => {
  s = Math.max(0, Math.floor(s ?? 0));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  return `${h ? `${h}:${mm.padStart(2, "0")}` : mm}:${String(s % 60).padStart(2, "0")}`;
};
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const audioUrl = (id) => `/api/plugins/meetings/x/meetings/${id}/audio`;

let selected = new URLSearchParams(location.search).get("id") ? Number(new URLSearchParams(location.search).get("id")) : undefined;
let list = [];
let meeting;
let tab = "summary";
let rec;
let setup;
let setupErr;
let poll;
let query = "";
let upload;
let kinds = [];
let newKind = "";
let seriesFilter;

const STATUS = {
  recording: '<span class="tag red">recording</span>',
  transcribing: '<span class="tag cobalt">transcribing</span>',
  summarising: '<span class="tag cobalt">writing it up</span>',
  failed: '<span class="tag red">failed</span>',
};
const busy = (m) => ["recording", "transcribing", "summarising"].includes(m?.status);

// --- recording ------------------------------------------------------------------

// the recorder itself is recorder.js, which other screens load too
async function startRecording(mode, opts = {}) {
  if (rec) return;
  const title = opts.app ? "" : $("#new-title")?.value ?? "";
  const series = opts.app ? "" : $("#new-series")?.value ?? "";
  const r = await cockpitRecorder.start({
    mode,
    begin: (type) => cockpit.api("/recordings/start", { method: "POST", body: { title, mode, type, kind: opts.app ? "" : newKind, series, app: opts.app } }),
    piece: (info, data) => cockpit.api(`/recordings/${info.rid}/chunk`, { method: "POST", body: { data } }),
    // stopped from another page or device
    onAnswer: (a) => a?.stop && rec === r && stopRecording(true),
  });
  rec = Object.assign(r, { mode, rid: r.info.rid, id: r.info.id, app: opts.app, started: r.startedAt });
  selected = rec.id;
  addEventListener("beforeunload", warn);
  rec.timer = setInterval(drawRecorder, 250);
  await load();
}

// The desktop app records meetings it notices in a hidden window of its own, through these. It passes a user
// gesture along, which sharing the computer's sound needs.
window.meetingsAuto = {
  // the computer's sound only comes with it on a Mac
  start: async ({ app }) => (await startRecording(window.desktop?.platform === "darwin" ? "mac" : "mic", { app }), rec.id),
  stop: async () => {
    const id = rec?.id;
    await stopRecording(true);
    return id;
  },
  recording: () => rec?.id,
};

const warn = (e) => (e.preventDefault(), (e.returnValue = "A meeting is being recorded"));
const send = async (rid, blob) => cockpit.api(`/recordings/${rid}/chunk`, { method: "POST", body: { data: await cockpitRecorder.toData(blob) } });

async function stopRecording(keep) {
  if (!rec) return;
  const r = rec;
  rec = undefined;
  clearInterval(r.timer);
  removeEventListener("beforeunload", warn);
  await r.stop();
  const failed = await cockpit.api(`/recordings/${r.rid}/${keep ? "finish" : "discard"}`, { method: "POST" }).then(() => undefined, (e) => e);
  if (!keep && !failed) selected = undefined;
  await load();
  if (failed) $("#new-err").innerHTML = error(`Couldn't ${keep ? "finish" : "discard"} the recording: ${failed.message}${keep ? ". What was sent is kept, and it's finished by itself in a minute or two." : ""}`);
}

const level = cockpitRecorder.level;

function drawRecorder() {
  const box = $("#recorder");
  if (!box || !rec) return;
  const bar = (label, v) => `<div class="meter"><span>${label}</span><i><b style="width:${Math.round(v * 100)}%"></b></i></div>`;
  $(".rec-time", box).textContent = clock((Date.now() - rec.started) / 1000);
  $(".meters", box).innerHTML = bar("You", level(rec.you)) + (rec.them ? bar("Others", level(rec.them)) : "");
  $(".rec-err", box).innerHTML = rec.err ? error(rec.err) : "";
}

function recorderHtml() {
  return `<div id="recorder" class="recorder">
    <div class="rec-head"><span class="dot"></span><strong>${esc(list.find((m) => m.id === rec.id)?.title ?? "Recording")}</strong><span class="faint rec-time">0:00</span></div>
    <div class="meters"></div>${rec.them ? "" : '<div class="faint" style="font-size:12px">Mic only: one voice track</div>'}
    <div class="mark-row"><input type="text" id="mark-text" placeholder="Mark this moment (optional note)" /><button class="small" id="mark">Mark</button></div>
    <div class="rec-err"></div>
    <div class="row" style="margin-top:8px"><button class="primary" id="rec-stop">Stop and write it up</button><button class="ghost" id="rec-drop">Discard</button></div>
  </div>`;
}

// an audio file from somewhere else, sent in pieces the same way a recording is
async function importFile(file) {
  const started = await cockpit.api("/recordings/start", { method: "POST", body: { mode: "file", name: file.name, type: file.type, title: $("#new-title")?.value ?? "", kind: newKind, series: $("#new-series")?.value ?? "" } });
  selected = started.id;
  upload = { name: file.name, done: 0, size: file.size };
  load();
  const step = 3 * 1024 * 1024;
  try {
    for (let at = 0; at < file.size; at += step) {
      await send(started.rid, file.slice(at, at + step));
      upload.done = Math.min(file.size, at + step);
      const p = $("#upload b");
      if (p) p.style.width = `${(upload.done / upload.size) * 100}%`;
    }
    await cockpit.api(`/recordings/${started.rid}/finish`, { method: "POST" });
  } catch (e) {
    // best effort: a half-sent import that can't be discarded is cleaned up when it stops getting audio
    await cockpit.api(`/recordings/${started.rid}/discard`, { method: "POST" }).catch(() => {});
    upload = undefined;
    await load();
    $("#new-err").innerHTML = error(`The import failed: ${e.message}`);
    return;
  }
  upload = undefined;
  load();
}

// --- the list -------------------------------------------------------------------

async function load() {
  try {
    const [l, d] = await Promise.all([cockpit.api(`/meetings${query ? `?q=${encodeURIComponent(query)}` : ""}`), selected ? cockpit.api(`/meetings/${selected}`).catch(() => undefined) : undefined]);
    // a meeting that can't be read was deleted elsewhere; the first one shows instead
    list = l.meetings;
    meeting = d;
    if (!meeting && !rec && list[0] && !query) {
      selected = list[0].id;
      meeting = await cockpit.api(`/meetings/${selected}`).catch(() => undefined);
    }
  } catch (e) {
    $("#left").innerHTML = error(e);
    newKey = undefined;
    return;
  }
  drawLeft();
  drawDetail();
  clearTimeout(poll);
  if (list.some(busy) || rec) poll = setTimeout(load, 4000);
}

let newKey;
function drawLeft() {
  if (!$("#newbox")) $("#left").innerHTML = '<div id="newbox"></div><div id="listbox"></div>';
  // the new-meeting card only redraws when what it shows changes, so typing in it isn't lost
  const key = `${rec?.id}|${upload ? 1 : 0}|${setup?.ready}|${setupErr}|${kinds.length}`;
  const fresh = key !== newKey;
  newKey = key;
  const title = $("#new-title")?.value ?? "";
  const seriesNow = $("#new-series")?.value ?? "";
  const allSeries = [...new Set(list.map((m) => m.series).filter(Boolean))];
  const pasting = !!$("#paste")?.open;
  const draft = $("#paste-text")?.value ?? "";
  const notReady = setup && !setup.ready;
  const hl = (t) => {
    let out = esc(t);
    for (const w of query.split(/\s+/).filter(Boolean)) out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    return out;
  };
  if (fresh) $("#newbox").innerHTML = `
    ${setupErr ? `<div class="card">${error(`Couldn't check whether transcription is set up: ${setupErr}`)}<button class="small" id="recheck" style="margin-top:8px">Check again</button></div>` : ""}
    ${notReady ? `<div class="card"><h2>Set up transcription</h2><p class="muted" style="font-size:13px">Meetings are transcribed ${setup.on ? `on ${esc(setup.on)}` : "on this computer"} with Whisper, which needs its own Python. This makes one with uv${setup.ffmpeg ? "" : ", and you'll need ffmpeg too"}. It downloads about 3 GB the first time.</p><button class="primary" id="setup">Set it up</button><div id="setup-msg"></div></div>` : ""}
    <div class="card" id="new">
      <h2>New meeting</h2>
      ${rec ? recorderHtml() : `
        <input type="text" id="new-title" placeholder="What's it about? (optional, Claude names it otherwise)" value="${esc(title)}" />
        <div class="kinds" role="radiogroup" aria-label="Kind of meeting">${[{ id: "", name: "Any kind" }, ...kinds].map((x) => `<button type="button" class="chip ${x.id === newKind ? "on" : ""}" data-kind="${esc(x.id)}">${esc(x.name)}</button>`).join("")}</div>
        <input type="text" id="new-series" list="series-list" placeholder="Part of a series? (optional, Claude spots them too)" value="${esc(seriesNow)}" />
        <datalist id="series-list">${allSeries.map((x) => `<option value="${esc(x)}"></option>`).join("")}</datalist>
        <div class="row" style="margin-top:8px">
          <button class="primary" data-rec="mac" title="Your mic, plus the sound of the meeting app on this computer">Record with the computer's sound</button>
          <button data-rec="mic" title="Only your mic, for a meeting in the room">Mic only</button>
        </div>
        <div class="row" style="margin-top:6px"><label class="small" style="font-size:13px;color:var(--muted);cursor:pointer"><input type="file" id="file" accept="audio/*,video/*" hidden /><u>Import a recording</u></label></div>
        ${upload ? `<div class="faint" style="font-size:12px;margin-top:6px">Sending ${esc(upload.name)}</div><div class="progress" id="upload"><b style="width:${(upload.done / upload.size) * 100}%"></b></div>` : ""}
        <details id="paste" ${pasting ? "open" : ""}><summary>Or paste a transcript</summary>
          <textarea id="paste-text" rows="6" placeholder="From Teams, Zoom, Meet or anywhere">${esc(draft)}</textarea>
          <div class="row" style="margin-top:6px;justify-content:flex-end"><button class="primary" id="paste-go">Write it up</button></div>
        </details>`}
      <div id="new-err"></div>
    </div>`;
  $("#listbox").innerHTML = `
    <section class="card"><h2>${query ? `Matching “${esc(query)}”` : seriesFilter ? `${esc(seriesFilter)} <button class="small ghost" id="unseries" title="Show every meeting">✕</button>` : "Meetings"}</h2><div class="list">
      ${list.filter((m) => !seriesFilter || m.series === seriesFilter).map((m) => `<button class="item ${m.id === selected ? "sel" : ""}" data-mid="${m.id}">
          <div class="t"><span>${esc(m.title)}</span>${STATUS[m.status] ?? ""}</div>
          <div class="s">${[m.series && !seriesFilter ? m.series : "", when(m.startedAt), m.duration ? clock(m.duration) : "", m.summary?.actions?.length ? `${m.summary.actions.filter((a) => !a.done).length} to do` : ""].filter(Boolean).join(" · ")}</div>
          ${m.hit ? `<div class="hit faint">${clock(m.hit.at)} ${hl(m.hit.text)}</div>` : ""}
        </button>`).join("") || `<div class="item s">${query ? "Nothing matches." : "No meetings yet."}</div>`}
    </div></section>`;
  if (rec) drawRecorder();
  const un = $("#unseries");
  if (un) un.onclick = () => ((seriesFilter = undefined), drawLeft());
  for (const b of document.querySelectorAll("[data-mid]")) b.onclick = () => ((selected = Number(b.dataset.mid)), (tab = "summary"), load());
  if (!fresh) return;
  for (const b of document.querySelectorAll("[data-rec]"))
    b.onclick = async () => {
      b.disabled = true;
      try {
        await startRecording(b.dataset.rec);
      } catch (e) {
        $("#new-err").innerHTML = error(e);
      } finally {
        b.disabled = false;
      }
    };
  for (const b of document.querySelectorAll("[data-kind]"))
    b.onclick = () => {
      newKind = b.dataset.kind;
      for (const c of document.querySelectorAll("[data-kind]")) c.classList.toggle("on", c === b);
    };
  const f = $("#file");
  if (f) f.onchange = () => f.files[0] && importFile(f.files[0]);
  const pg = $("#paste-go");
  if (pg)
    pg.onclick = async () => {
      try {
        const r = await cockpit.api("/meetings/paste", { method: "POST", body: { transcript: $("#paste-text").value, title: $("#new-title").value, kind: newKind, series: $("#new-series").value } });
        $("#paste-text").value = "";
        $("#new-title").value = "";
        selected = r.id;
        load();
      } catch (e) {
        $("#new-err").innerHTML = error(e);
      }
    };
  const s = $("#setup");
  if (s)
    s.onclick = async () => {
      s.disabled = true;
      try {
        await cockpit.api("/setup", { method: "POST" });
      } catch (e) {
        s.disabled = false;
        return ($("#setup-msg").innerHTML = error(`Couldn't start the setup: ${e.message}`));
      }
      $("#setup-msg").innerHTML = '<p class="faint" style="font-size:13px">Installing. It runs as a job, and you get a notification when it\'s done.</p>';
      const check = setInterval(async () => {
        try {
          setup = await cockpit.api("/setup");
        } catch (e) {
          if ($("#setup-msg")) $("#setup-msg").innerHTML = error(`Couldn't check on the setup: ${e.message}. It carries on as a job.`);
          return;
        }
        if (setup.ready) clearInterval(check), drawLeft();
      }, 10000);
    };
  const rc = $("#recheck");
  if (rc) rc.onclick = checkSetup;
  if (rec) {
    const mark = async () => {
      const text = $("#mark-text").value;
      $("#mark-text").value = "";
      try {
        await cockpit.api(`/meetings/${rec.id}/marks`, { method: "POST", body: { at: (Date.now() - rec.started) / 1000, text } });
      } catch (e) {
        $("#mark-text").value = text;
        rec.err = `Couldn't mark it: ${e.message}`;
        return;
      }
      $("#mark").textContent = "Marked";
      setTimeout(() => $("#mark") && ($("#mark").textContent = "Mark"), 1200);
    };
    $("#mark").onclick = mark;
    $("#mark-text").onkeydown = (e) => e.key === "Enter" && mark();
    $("#rec-stop").onclick = () => stopRecording(true);
    $("#rec-drop").onclick = () => confirm("Throw this recording away?") && stopRecording(false);
  }
}

// --- one meeting ----------------------------------------------------------------

const speaker = (s) => (s.speaker ? `<b class="${s.speaker === "Others" ? "them" : "you"}">${esc(s.speaker)}</b>` : "");
function transcriptHtml(segs, filter = "") {
  const f = filter.toLowerCase();
  return segs
    .map((s, i) => (f && !s.text.toLowerCase().includes(f) ? "" : `<div class="seg" data-i="${i}" data-t="${s.start}">${meeting.mode === "paste" ? "" : `<button class="time" data-seek="${s.start}">${clock(s.start)}</button>`}<div>${s.speaker !== segs[i - 1]?.speaker || f ? speaker(s) : ""}${esc(s.text)}</div></div>`))
    .join("");
}

function markdown(m) {
  const s = m.summary;
  const out = [`# ${m.title}`, when(m.startedAt) + (m.duration ? ` · ${clock(m.duration)}` : "")];
  if (!s) return out.join("\n");
  out.push("", s.tldr);
  for (const [t, items] of Object.entries(s.sections ?? {})) out.push("", `## ${t}`, ...items.map((x) => `- ${x}`));
  if (s.since?.changed.length || s.since?.carried.length || s.since?.closed.length)
    out.push("", "## Since last time", ...s.since.changed.map((x) => `- ${x}`), ...s.since.closed.map((a) => `- Done: ${a.what}`), ...s.since.carried.map((a) => `- Still open: ${a.what}${a.who ? ` (${a.who})` : ""}`));
  if (s.actions.length) out.push("", "## Action items", ...s.actions.map((a) => `- [${a.done ? "x" : " "}] ${a.what}${a.who ? ` (${a.who}${a.due ? `, ${a.due}` : ""})` : a.due ? ` (${a.due})` : ""}`));
  if (s.decisions.length) out.push("", "## Decisions", ...s.decisions.map((d) => `- ${d}`));
  if (s.questions.length) out.push("", "## Open questions", ...s.questions.map((d) => `- ${d}`));
  if (s.topics.length) out.push("", "## Topics", ...s.topics.map((t) => `- ${clock(t.at)} **${t.title}**: ${t.summary}`));
  return out.join("\n");
}

// what moved since the last meeting in the series; items still open can be ticked here, where they're shown
function sinceHtml(since) {
  if (!since || !(since.changed.length || since.closed.length || since.carried.length)) return "";
  const where = (a) => {
    const from = list.find((m) => m.id === a.meeting);
    return from ? `<button class="from ghost small" data-mid="${a.meeting}" title="Open that meeting">${esc(new Date(from.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }))}</button>` : "";
  };
  return `<div class="sec since"><h3>Since last time</h3>
    ${since.changed.length ? `<ul>${since.changed.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${since.closed.length ? `<div class="actions">${since.closed.map((a) => `<label class="done"><input type="checkbox" checked disabled /><span>${esc(a.what)}${where(a)}</span></label>`).join("")}</div>` : ""}
    ${since.carried.length ? `<div class="actions"><div class="faint" style="font-size:12px;margin-top:6px">Still open</div>${since.carried.map((a) => { const cur = list.find((m) => m.id === a.meeting)?.summary?.actions[a.index]; return `<label class="${cur?.done ? "done" : ""}"><input type="checkbox" data-earlier="${a.meeting}:${a.index}" ${cur?.done ? "checked" : ""} /><span>${esc(a.what)}${a.who ? `<span class="who">${esc(a.who)}</span>` : ""}${where(a)}</span></label>`; }).join("")}</div>` : ""}
  </div>`;
}

let notesTimer;
function drawDetail() {
  const box = $("#detail");
  const m = meeting;
  if (!m) return (box.innerHTML = `<div class="card empty">${rec ? "Starting" : "Record, import or paste a meeting to start."}</div>`);
  const filter = $("#tfilter")?.value ?? "";
  const notes = document.activeElement?.id === "notes" ? $("#notes").value : m.notes ?? "";
  const playing = $("#player");
  const keepAudio = playing && playing.dataset.meeting === String(m.id);
  const audioHtml = m.audio && !busy(m) ? (keepAudio ? "" : `<audio id="player" data-meeting="${m.id}" controls preload="metadata" src="${audioUrl(m.id)}"></audio>`) : "";
  const s = m.summary;
  const listOf = (title, items) => (items?.length ? `<div class="sec"><h3>${title}</h3><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "");

  const summary = s
    ? `<p class="tldr">${esc(s.tldr)}</p>
      ${sinceHtml(s.since)}
      ${Object.entries(s.sections ?? {}).map(([t, items]) => listOf(esc(t), items)).join("")}
      ${s.actions.length ? `<div class="sec actions"><h3>Action items</h3>${s.actions.map((a, i) => `<label class="${a.done ? "done" : ""}"><input type="checkbox" data-act="${i}" ${a.done ? "checked" : ""} /><span>${esc(a.what)}${a.who || a.due ? `<span class="who">${esc([a.who, a.due].filter(Boolean).join(" · "))}</span>` : ""}</span></label>`).join("")}</div>` : ""}
      ${listOf("Decisions", s.decisions)}${listOf("Open questions", s.questions)}
      ${s.topics.length ? `<div class="sec"><h3>Topics</h3>${s.topics.map((t) => `<div class="topic">${m.mode === "paste" ? "" : `<button class="time" data-seek="${t.at}">${clock(t.at)}</button>`}<div><strong style="font-weight:500">${esc(t.title)}</strong> ${esc(t.summary)}</div></div>`).join("")}</div>` : ""}
      ${m.marks?.length ? `<div class="sec"><h3>Marked moments</h3>${m.marks.map((x) => `<div class="topic"><button class="time" data-seek="${x.at}">${clock(x.at)}</button><div>${esc(x.text || "Marked")}</div></div>`).join("")}</div>` : ""}`
    : m.status === "summarising"
      ? '<p class="muted">Claude is writing it up.</p>'
      : m.status === "transcribing"
        ? '<p class="muted">Transcribing the rest of the recording, then Claude writes it up.</p>'
        : '<p class="muted">No write-up yet.</p>';

  // while recording only the captions move, so notes being typed keep their place
  if (m.status === "recording" && $(".live #said") && box.dataset.shown === String(m.id)) {
    const said = $("#said");
    const end = said.scrollTop + said.clientHeight >= said.scrollHeight - 20;
    if (m.segments.length) said.innerHTML = transcriptHtml(m.segments);
    if (end) said.scrollTop = said.scrollHeight;
    return;
  }
  box.dataset.shown = m.id;
  if (m.status === "recording") {
    const here = rec?.id === m.id || (upload && m.mode === "file");
    // during the meeting: captions as they come, and somewhere for notes
    box.innerHTML = `${here ? "" : `<div class="card elsewhere"><div class="row"><span class="dot"></span><span style="flex:1">Recording ${m.app ? `the ${esc(m.app)} meeting ` : ""}somewhere else${m.app ? ", started when it used your mic" : ""}.</span><button class="primary small" id="stop-elsewhere">Stop and write it up</button></div></div>`}<div id="detail-err"></div><div class="card live">
        <div class="meta">${esc(m.title)} · ${when(m.startedAt)} · ${m.mode === "file" ? "importing" : "recording"}</div>
        <div class="said" id="said">${m.segments.length ? transcriptHtml(m.segments) : `<p class="faint">${m.mode === "file" ? "The recording is on its way." : "The transcript shows here a few seconds after things are said."}</p>`}</div>
      </div>
      <div class="card"><h2>Your notes</h2><textarea id="notes" rows="5" placeholder="Claude reads these with the transcript">${esc(notes)}</textarea></div>`;
    const said = $("#said");
    said.scrollTop = said.scrollHeight;
  } else {
    if (keepAudio) playing.remove();
    box.innerHTML = `<div class="card">
        <div class="row" style="align-items:flex-start;flex-wrap:nowrap"><input class="title-in" id="title" value="${esc(m.title)}" aria-label="Title" />${STATUS[m.status] ?? ""}</div>
        <div class="meta">${m.series ? `<button class="series-link" data-series="${esc(m.series)}">${esc(m.series)}</button>${seriesNav(m)} · ` : ""}${kinds.find((x) => x.id === m.kind) ? `${esc(kinds.find((x) => x.id === m.kind).name)} · ` : ""}${when(m.startedAt)}${m.duration ? ` · ${clock(m.duration)}` : ""}${m.app ? ` · ${esc(m.app)}` : ""}${m.mode === "mac" ? " · both sides" : m.mode === "mic" ? " · mic" : m.mode === "file" ? " · imported" : " · pasted"}${m.language ? ` · ${esc(m.language)}` : ""}</div>
        ${m.error ? `<div class="error">${esc(m.error)}</div>` : ""}
        <div id="detail-err"></div>
        <div id="audiobox">${audioHtml}</div>
        <div class="row">
          <div class="tabs"><button data-tab="summary" class="${tab === "summary" ? "on" : ""}">Summary</button><button data-tab="transcript" class="${tab === "transcript" ? "on" : ""}">Transcript</button><button data-tab="notes" class="${tab === "notes" ? "on" : ""}">Notes</button></div>
          <span style="flex:1"></span>
          ${s ? '<button class="small" id="copy">Copy</button>' : ""}
          <button class="small" id="ask" ${busy(m) ? "disabled" : ""}>Ask Claude</button>
          <select id="again-kind" class="small" title="Kind of meeting" ${busy(m) ? "disabled" : ""}><option value="">Any kind</option>${kinds.map((x) => `<option value="${esc(x.id)}" ${x.id === m.kind ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
          <button class="small ghost" id="again" ${busy(m) ? "disabled" : ""}>${m.status === "failed" ? "Try again" : "Write it up again"}</button>
          <button class="small ghost" id="del">Delete</button>
        </div>
        <datalist id="series-list-d">${[...new Set(list.map((x) => x.series).filter(Boolean))].map((x) => `<option value="${esc(x)}"></option>`).join("")}</datalist>
        <div id="tabbody">${
          tab === "summary"
            ? summary
            : tab === "transcript"
              ? `<input type="text" id="tfilter" placeholder="Find in the transcript" value="${esc(filter)}" style="margin-bottom:6px" /><div class="said" id="said">${transcriptHtml(m.segments, filter) || '<p class="faint">No transcript.</p>'}</div>`
              : `<textarea id="notes" rows="10" placeholder="Your notes. Claude reads them when it writes the meeting up again">${esc(notes)}</textarea>
                <label class="faint" style="font-size:13px;display:block;margin-top:10px">Series <input type="text" id="series" list="series-list-d" value="${esc(m.series ?? "")}" placeholder="Not part of a series" /></label>
                <p class="faint" style="font-size:12px">Change it and write the meeting up again to compare it with the series' last meeting.</p>`
        }</div>
      </div>`;
    if (keepAudio) $("#audiobox").append(playing);
  }
  wireDetail(m);
}

// earlier and later meetings in the same series
function seriesNav(m) {
  const same = list.filter((x) => x.series === m.series).sort((a, b) => a.startedAt - b.startedAt);
  const i = same.findIndex((x) => x.id === m.id);
  if (same.length < 2) return "";
  const prev = same[i - 1], next = same[i + 1];
  return ` <span class="nav">${prev ? `<button class="ghost small" data-mid="${prev.id}" title="${esc(prev.title)}">‹</button>` : ""}${i + 1} of ${same.length}${next ? `<button class="ghost small" data-mid="${next.id}" title="${esc(next.title)}">›</button>` : ""}</span>`;
}

// a change saved from the meeting's page; a failure shows above it
const saving = (p) => p.catch((e) => ($("#detail-err") ? ($("#detail-err").innerHTML = error(`Couldn't save that: ${e.message}`)) : undefined));

function wireDetail(m) {
  for (const b of $("#detail").querySelectorAll("[data-mid]")) b.onclick = () => ((selected = Number(b.dataset.mid)), (tab = "summary"), load());
  for (const b of $("#detail").querySelectorAll("[data-series]")) b.onclick = () => ((seriesFilter = b.dataset.series), (query = ""), ($("#search").value = ""), load());
  for (const c of $("#detail").querySelectorAll("[data-earlier]"))
    c.onchange = async () => {
      const [mid, index] = c.dataset.earlier.split(":").map(Number);
      c.closest("label").classList.toggle("done", c.checked);
      await saving(cockpit.api(`/meetings/${mid}`, { method: "PUT", body: { done: { index, done: c.checked } } }).then(async () => (list = (await cockpit.api("/meetings")).meetings)));
    };
  const se = $("#stop-elsewhere");
  if (se)
    se.onclick = async () => {
      se.disabled = true;
      se.textContent = "Stopping";
      try {
        await cockpit.api(`/meetings/${m.id}/stop`, { method: "POST" });
      } catch (e) {
        se.disabled = false;
        se.textContent = "Stop and write it up";
        return ($("#detail-err").innerHTML = error(e));
      }
      setTimeout(load, 6000);
    };
  const sr = $("#series");
  if (sr) sr.onchange = () => saving(cockpit.api(`/meetings/${m.id}`, { method: "PUT", body: { series: sr.value } }).then(load));
  const player = $("#player");
  for (const b of document.querySelectorAll("[data-seek]"))
    b.onclick = () => {
      if (!player) return;
      player.currentTime = Number(b.dataset.seek);
      player.play();
    };
  if (player) player.ontimeupdate = () => follow(player.currentTime);
  for (const b of document.querySelectorAll("[data-tab]")) b.onclick = () => ((tab = b.dataset.tab), drawDetail());
  const t = $("#title");
  if (t) t.onchange = () => saving(cockpit.api(`/meetings/${m.id}`, { method: "PUT", body: { title: t.value } }).then(load));
  const n = $("#notes");
  if (n) n.oninput = () => (clearTimeout(notesTimer), (notesTimer = setTimeout(() => saving(cockpit.api(`/meetings/${m.id}`, { method: "PUT", body: { notes: n.value } })), 600)));
  const tf = $("#tfilter");
  if (tf) tf.oninput = () => ($("#said").innerHTML = transcriptHtml(m.segments, tf.value) || '<p class="faint">Nothing matches.</p>', wireDetail(m), tf.focus());
  for (const c of document.querySelectorAll("[data-act]"))
    c.onchange = async () => {
      m.summary.actions[Number(c.dataset.act)].done = c.checked;
      c.closest("label").classList.toggle("done", c.checked);
      await saving(cockpit.api(`/meetings/${m.id}`, { method: "PUT", body: { done: { index: Number(c.dataset.act), done: c.checked } } }));
    };
  const copy = $("#copy");
  if (copy)
    copy.onclick = () => {
      cockpit.copy(markdown(m));
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    };
  const ask = $("#ask");
  if (ask)
    ask.onclick = async () => {
      try {
        const r = await cockpit.api(`/meetings/${m.id}/ask`, { method: "POST", body: {} });
        cockpit.navigate(`/terminals?id=${r.term}`);
      } catch (e) {
        $("#detail-err").innerHTML = error(e);
      }
    };
  const again = $("#again");
  if (again)
    again.onclick = async () => {
      try {
        await cockpit.api(`/meetings/${m.id}`, { method: "PUT", body: { kind: $("#again-kind").value } });
        await cockpit.api(`/meetings/${m.id}/summarise`, { method: "POST" });
      } catch (e) {
        return ($("#detail-err").innerHTML = error(e));
      }
      load();
    };
  const del = $("#del");
  if (del)
    del.onclick = async () => {
      if (!confirm("Delete this meeting, its recording and transcript?")) return;
      try {
        await cockpit.api(`/meetings/${m.id}`, { method: "DELETE" });
      } catch (e) {
        return ($("#detail-err").innerHTML = error(e));
      }
      selected = undefined;
      load();
    };
}

// the line being played stays highlighted and in view
let lastNow;
function follow(t) {
  if (tab !== "transcript") return;
  const segs = [...document.querySelectorAll(".seg")];
  const now = segs.filter((s) => Number(s.dataset.t) <= t).pop();
  if (now === lastNow) return;
  lastNow?.classList.remove("now");
  now?.classList.add("now");
  lastNow = now;
  now?.scrollIntoView({ block: "nearest" });
}

let qtimer;
$("#search").oninput = (e) => (clearTimeout(qtimer), (qtimer = setTimeout(() => ((query = e.target.value.trim()), load()), 250)));
// best effort: without the kinds, Claude picks the kind itself
cockpit.api("/kinds").then((k) => ((kinds = k), drawLeft(), drawDetail())).catch(() => {});
function checkSetup() {
  cockpit.api("/setup").then(
    (s) => ((setup = s), (setupErr = undefined), drawLeft()),
    (e) => ((setupErr = e.message), drawLeft()),
  );
}
checkSetup();
load();
