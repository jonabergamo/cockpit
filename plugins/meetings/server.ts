import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cockpit } from "@cockpit/shared";

interface Segment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

interface Action {
  what: string;
  who?: string;
  due?: string;
  done?: boolean;
}

// an action item from an earlier meeting in the same series
interface Earlier extends Action {
  meeting: number;
  index: number;
}

interface Summary {
  title?: string;
  tldr: string;
  decisions: string[];
  actions: Action[];
  questions: string[];
  topics: { at: number; title: string; summary: string }[];
  // what the meeting's kind asks for, by section title
  sections?: Record<string, string[]>;
  // for a meeting in a series: what moved since the last one
  since?: { changed: string[]; closed: Earlier[]; carried: Earlier[] };
}

// a kind of meeting, and what its write-up should have beyond the usual
interface Kind {
  id: string;
  name: string;
  focus?: string;
  sections?: { title: string; hint?: string }[];
}

const KINDS: Kind[] = [
  { id: "general", name: "General" },
  {
    id: "standup",
    name: "Stand-up",
    focus: "It's a stand-up: keep it short and go person by person.",
    sections: [
      { title: "By person", hint: "one item per person: what they did, what's next and anything in their way" },
      { title: "Blockers", hint: "what's stuck, and who said they'd unblock it" },
    ],
  },
  {
    id: "planning",
    name: "Planning",
    focus: "It's a planning meeting: what the team takes on, and what it leaves out.",
    sections: [
      { title: "Taken on", hint: "the work picked, with ticket keys, owners and estimates when they were said" },
      { title: "Left out", hint: "work that was talked about and not picked, and why" },
      { title: "Risks", hint: "dependencies, unknowns and anything that could make the plan slip" },
    ],
  },
  {
    id: "one-on-one",
    name: "1:1",
    focus: "It's a 1:1. Write it for the two people in it, plainly and kindly, without judging anyone.",
    sections: [
      { title: "How things are going", hint: "workload, energy and concerns raised, in their words" },
      { title: "Feedback", hint: "feedback given in either direction" },
      { title: "Growth", hint: "goals, skills and opportunities talked about" },
    ],
  },
  {
    id: "interview",
    name: "Interview",
    focus: "It's a job interview. Stick to what the candidate said and showed; never guess at things they didn't cover.",
    sections: [
      { title: "Candidate", hint: "their background in a line or two" },
      { title: "By area", hint: "one item per area covered: what they showed, with examples they gave" },
      { title: "Strengths", hint: "" },
      { title: "Concerns", hint: "gaps or red flags, with what they were based on" },
      { title: "Recommendation", hint: "only if an interviewer gave one; leave it empty otherwise" },
    ],
  },
  {
    id: "retro",
    name: "Retro",
    focus: "It's a retrospective.",
    sections: [
      { title: "Went well", hint: "" },
      { title: "Didn't go well", hint: "" },
      { title: "Ideas", hint: "changes people suggested to try" },
    ],
  },
  {
    id: "review",
    name: "Demo or review",
    focus: "Something was shown to people for feedback.",
    sections: [
      { title: "Shown", hint: "what was demoed or reviewed" },
      { title: "Feedback", hint: "what people said about it, and who" },
    ],
  },
];

// a moment marked while recording, with what you typed about it
interface Mark {
  at: number;
  text: string;
}

interface Meeting {
  id: number;
  title: string;
  startedAt: number;
  // mac: your mic and the computer's sound, mic: the mic only, file: an imported recording, paste: a pasted transcript
  mode: "mac" | "mic" | "file" | "paste";
  status: "recording" | "transcribing" | "summarising" | "done" | "failed";
  audio?: string;
  duration?: number;
  language?: string;
  error?: string;
  summary?: Summary;
  marks?: Mark[];
  notes?: string;
  // the title came from you, so a summary doesn't replace it
  named?: boolean;
  // the kind of meeting; empty lets Claude pick
  kind?: string;
  // a name shared by meetings that follow on from each other, like a weekly stand-up
  series?: string;
  // the app that was using the mic when the recording started by itself
  app?: string;
}

const here = dirname(fileURLToPath(import.meta.url));

export default function setup(k: Cockpit) {
  const home = (p: string) => p.replace(/^~/, homedir());
  const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
  const dir = join(k.dataDir, "meetings");
  mkdirSync(dir, { recursive: true });

  // the list stays small; each meeting's transcript lives in its own file
  const all = () => k.store.get<Meeting[]>("meetings") ?? [];
  const saveAll = (list: Meeting[]) => k.store.set("meetings", list);
  const find = (id: number) => all().find((m) => m.id === id);
  function update(id: number, fn: (m: Meeting) => void) {
    const list = all();
    const m = list.find((x) => x.id === id);
    if (!m) return undefined;
    fn(m);
    saveAll(list);
    return m;
  }
  const textFile = (id: number) => join(dir, `${id}.json`);
  const readText = (id: number): Segment[] => (existsSync(textFile(id)) ? JSON.parse(readFileSync(textFile(id), "utf8")) : []);
  const saveText = (id: number, segs: Segment[]) => writeFileSync(textFile(id), JSON.stringify(segs), { mode: 0o600 });
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const asText = (segs: Segment[], times = false) =>
    segs
      .map((s, i) => {
        const who = s.speaker && s.speaker !== segs[i - 1]?.speaker ? `${s.speaker}: ` : "";
        return `${times ? `[${clock(s.start)}] ` : ""}${who}${s.text}`;
      })
      .join("\n");

  k.screen({ id: "meetings", title: "Meetings", page: "assets/index.html" });

  // ---- transcription: one Whisper process that keeps the model loaded while it's in use ----

  const python = () => home(k.setting<string>("whisperPython") || "~/.local/share/cockpit-whisper/bin/python");
  type Heard = { language?: string; duration: number; segments: Segment[]; error?: string };
  let worker: ChildProcess | undefined;
  let wbuf = "";
  let seq = 0;
  let idle: NodeJS.Timeout | undefined;
  const waiting = new Map<number, (r: Heard) => void>();
  // on the machine Settings → Machines puts transcription on: this one, or another (one with a GPU, say) where
  // this plugin runs too and gets the recording copied over, only the new part when it has grown
  const names = () => [k.setting<string>("myName") || "You", "Others", ""];
  async function hear(file: string, from = 0): Promise<Heard> {
    const on = k.where("whisper");
    if (!on) return hearHere(file, from, names());
    return k
      .remote(on)
      .call<Heard>("hear", { from, names: names() }, { files: { audio: file }, timeoutMs: 90 * 60_000 })
      .catch((e: Error) => ({ duration: 0, segments: [], error: `transcribing on ${on} failed: ${e.message}` }));
  }
  k.expose("hear", (a: { from?: number; names?: string[] }, files) => hearHere(files.audio, a.from ?? 0, a.names ?? names()));

  function hearHere(file: string, from: number, who: string[]): Promise<Heard> {
    if (!existsSync(python())) return Promise.resolve({ duration: 0, segments: [], error: "Transcription isn't set up yet: open Meetings and press Set it up" });
    if (!worker) {
      const w = spawn(python(), [join(here, "transcribe.py"), "--serve", k.setting<string>("whisperModel") || "large-v3-turbo"], { stdio: ["pipe", "pipe", "ignore"] });
      worker = w;
      w.stdout!.on("data", (d) => {
        wbuf += d;
        let i;
        while ((i = wbuf.indexOf("\n")) >= 0) {
          const line = wbuf.slice(0, i);
          wbuf = wbuf.slice(i + 1);
          try {
            const r = JSON.parse(line);
            waiting.get(r.id)?.(r);
            waiting.delete(r.id);
          } catch {}
        }
      });
      w.on("exit", () => {
        if (worker === w) worker = undefined;
        for (const done of waiting.values()) done({ duration: 0, segments: [], error: "the transcriber stopped" });
        waiting.clear();
      });
    }
    clearTimeout(idle);
    idle = setTimeout(() => worker?.kill(), 10 * 60_000);
    const id = ++seq;
    return new Promise((ok) => {
      waiting.set(id, ok);
      setTimeout(() => waiting.has(id) && (waiting.delete(id), ok({ duration: 0, segments: [], error: "the transcription took too long" })), 90 * 60_000);
      worker!.stdin!.write(JSON.stringify({ id, file, from, names: who }) + "\n");
    });
  }
  k.onStop(() => worker?.kill());

  // ---- the summary: Claude reads the whole transcript once the meeting is over ----

  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const kinds = (): Kind[] => {
    const mine = k.setting<Kind[]>("kinds");
    const out = KINDS.map((x) => ({ ...x }));
    for (const x of Array.isArray(mine) ? mine : []) {
      if (!x?.id || !x.name) continue;
      const i = out.findIndex((y) => y.id === x.id);
      if (i >= 0) out[i] = { ...out[i], ...x };
      else out.push(x);
    }
    return out;
  };
  const open = (m: Meeting) => (m.summary?.actions ?? []).map((a, index) => ({ ...a, meeting: m.id, index })).filter((a) => !a.done);
  const short = (m: Meeting) => `${new Date(m.startedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} "${m.title}"`;

  // Earlier meetings this one may follow on from: the last meeting of each series, and recent ones in none,
  // each with its summary and the action items still open across its series.
  function candidates(m: Meeting) {
    const earlier = all().filter((x) => x.id !== m.id && x.startedAt < m.startedAt && x.summary);
    const out: { ref: string; meeting: Meeting; open: Earlier[] }[] = [];
    const seen = new Set<string>();
    for (const x of earlier) {
      if (m.series && x.series !== m.series) continue;
      const ref = x.series ? `series:${x.series}` : `meeting:${x.id}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push({ ref, meeting: x, open: x.series ? earlier.filter((y) => y.series === x.series).flatMap(open) : open(x) });
      if (out.length >= (m.series ? 1 : 10)) break;
    }
    return out;
  }

  async function summarise(id: number) {
    const m = find(id);
    if (!m) return;
    const segs = readText(id);
    if (!segs.length) {
      update(id, (x) => Object.assign(x, { status: "done", error: "Nothing was said in the recording" }));
      return;
    }
    update(id, (x) => ((x.status = "summarising"), delete x.error));
    const me = k.setting<string>("myName") || "You";
    const lang = k.setting<string>("summaryLanguage") || "the language most of the meeting was in";
    const marks = (m.marks ?? []).map((x) => `[${clock(x.at)}] ${x.text || "(marked as important)"}`).join("\n");
    const all_ = kinds();
    const series = m.series ? all().filter((x) => x.series === m.series && x.id !== m.id && x.kind) : [];
    const kindId = m.kind || series[0]?.kind || "";
    const kind = all_.find((x) => x.id === kindId);
    const kindText = (x: Kind) => [x.focus, x.sections?.length ? `Its sections: ${x.sections.map((s) => `"${s.title}"${s.hint ? ` (${s.hint})` : ""}`).join(", ")}.` : ""].filter(Boolean).join(" ");
    const before = candidates(m);
    const earlierText = before
      .map((c) => [`- ${c.ref}: ${short(c.meeting)}${c.meeting.series ? `, the latest in "${c.meeting.series}"` : ""}${c.meeting.kind ? `, a ${c.meeting.kind}` : ""}. ${c.meeting.summary!.tldr}`, ...c.open.map((a) => `  - open item m${a.meeting}a${a.index}: ${a.what}${a.who ? ` (${a.who})` : ""}`)].join("\n"))
      .join("\n");
    const prompt = [
      `Summarise this meeting from its transcript. Don't use any tools, just answer.`,
      `Lines are [mm:ss] times from the start. ${m.mode === "mac" ? `"${me}" is me, the person who recorded it; "Others" is everyone else on the call, so tell people apart by what they say when you can.` : "It was recorded from one microphone, so speakers aren't labelled."}`,
      `The transcript comes from speech recognition: fix misheard words from context and don't quote it word for word.`,
      `Write in ${lang}. Be concrete: names, numbers, dates, systems. Leave a list empty rather than padding it.`,
      k.setting<string>("summaryInstructions") || "",
      kind
        ? `${kindText(kind) || "It's a general meeting."} Set "kind" to "${kind.id}".`
        : `First decide what kind of meeting it was, from: ${all_.map((x) => `"${x.id}" (${x.name})`).join(", ")}. Set "kind" to it and follow what that kind asks for:\n${all_.filter((x) => x.focus || x.sections?.length).map((x) => `- ${x.id}: ${kindText(x)}`).join("\n")}`,
      before.length
        ? m.series
          ? `This meeting is the next one in the series "${m.series}". Its previous meeting:\n${earlierText}\nFill "since": what changed since then, the open items it closed (said to be done or no longer needed) and the ones still open. Don't repeat an item that's still open in "actions" unless something about it changed. Set "continues" to "${before[0].ref}".`
          : `Earlier meetings it may follow on from (a recurring meeting, or the next step of the same work):\n${earlierText}\nIf it clearly follows on from one of them, set "continues" to that ref, and for a meeting ref also "seriesName", a short name for the recurring meeting like "Payments stand-up". Then fill "since", and don't repeat an item that's still open in "actions" unless something about it changed. If it doesn't clearly follow on from one, leave "continues" empty and "since" empty. Don't link meetings just because they share a topic.`
        : "",
      `Answer with only a JSON object, no code fence:`,
      `{"title": "a short title naming what it was about", "kind": "the kind id", "tldr": "two or three sentences", "sections": {"section title": ["items, for the kind's sections only"]}, "decisions": ["what was decided"], "actions": [{"what": "the task", "who": "who said they'd do it, or empty", "due": "when, if said, or empty"}], "questions": ["what was left open"], "topics": [{"at": seconds where it starts, "title": "a few words", "summary": "one or two sentences"}]${before.length ? `, "continues": "ref or empty", "seriesName": "", "since": {"changed": ["what moved since the earlier meeting"], "closed": ["open item ids now done"], "carried": ["open item ids still open"]}` : ""}}`,
      m.notes ? `\nMy notes from the meeting:\n${m.notes}` : "",
      marks ? `\nMoments I marked as important while recording:\n${marks}` : "",
      `\nTranscript:\n${asText(segs, true)}`,
    ]
      .filter(Boolean)
      .join("\n");
    const file = join(dir, `${id}.prompt.txt`);
    writeFileSync(file, prompt, { mode: 0o600 });
    const model = k.setting<string>("summaryModel");
    const r = await k.job(`summarise ${m.title}`, `claude -p ${model ? `--model ${q(model)} ` : ""}< ${q(file)}`, dir);
    rmSync(file, { force: true });
    const json = r.output.slice(r.output.indexOf("{"), r.output.lastIndexOf("}") + 1);
    type Out = Summary & { kind?: string; continues?: string; seriesName?: string; since?: { changed?: string[]; closed?: string[]; carried?: string[] } };
    let s: Out | undefined;
    try {
      s = JSON.parse(json);
    } catch {}
    if (r.code !== 0 || !s?.tldr) {
      update(id, (x) => Object.assign(x, { status: "failed", error: `Claude couldn't summarise it${r.code ? ` (exit ${r.code})` : ""}. Try again from the meeting.` }));
      k.notify({ title: "Couldn't summarise the meeting", body: m.title, link: `/p/meetings/meetings?id=${id}` });
      return;
    }

    // which series it joins: the one it was put in, one Claude matched, or a new one with an earlier meeting
    const picked = before.find((c) => c.ref === s.continues);
    let joined = m.series;
    if (!joined && picked) {
      joined = picked.meeting.series || s.seriesName?.trim() || picked.meeting.title;
      if (!picked.meeting.series) update(picked.meeting.id, (x) => (x.series = joined));
    }
    const pool = new Map((picked ?? (m.series ? before[0] : undefined))?.open.map((a) => [`m${a.meeting}a${a.index}`, a]) ?? []);
    const pick = (ids?: string[]) => (ids ?? []).map((x) => pool.get(x)).filter((a): a is Earlier => !!a);
    const since = pool.size || s.since?.changed?.length ? { changed: s.since?.changed ?? [], closed: pick(s.since?.closed), carried: pick(s.since?.carried) } : undefined;
    // what this meeting closed gets ticked off where it was first said
    for (const a of since?.closed ?? []) update(a.meeting, (x) => x.summary?.actions[a.index] && (x.summary.actions[a.index].done = true));

    const sectionTitles = new Set((all_.find((x) => x.id === s.kind)?.sections ?? []).map((x) => x.title));
    const sections = Object.fromEntries(Object.entries(s.sections ?? {}).filter(([t, v]) => sectionTitles.has(t) && Array.isArray(v) && v.length));
    const done = update(id, (x) => {
      x.summary = {
        tldr: s.tldr,
        decisions: s.decisions ?? [],
        actions: (s.actions ?? []).map((a) => ({ what: a.what, who: a.who || undefined, due: a.due || undefined })),
        questions: s.questions ?? [],
        topics: s.topics ?? [],
        sections,
        since,
      };
      if (s.title && !x.named) x.title = s.title;
      if (!x.kind && all_.some((y) => y.id === s.kind)) x.kind = s.kind;
      if (joined) x.series = joined;
      x.status = "done";
    });
    k.notify({ title: "Meeting summarised", body: `${done?.title}: ${s.tldr.slice(0, 120)}`, link: `/p/meetings/meetings?id=${id}` });
  }

  async function transcribe(id: number, file: string, from: number, kept: Segment[]) {
    const d = await hear(file, from);
    if (!find(id)) return;
    if (d.error) {
      update(id, (x) => Object.assign(x, { status: "failed", error: `The transcription didn't finish (${d.error}). The recording is kept.` }));
      return;
    }
    const segs = [...kept, ...d.segments];
    saveText(id, segs);
    update(id, (x) => Object.assign(x, { duration: Math.max(d.duration, x.duration ?? 0), language: d.language ?? x.language }));
    await summarise(id);
  }

  // ---- recording: the page sends the audio in pieces while the meeting goes on ----

  interface Live {
    file: string;
    id: number;
    lastAt: number;
    // live captions: how far it's been transcribed and what's been heard
    heard: number;
    segments: Segment[];
    lastRun: number;
    running: boolean;
    // asked to stop from somewhere other than the page recording it
    stop?: boolean;
  }
  const live = new Map<string, Live>();
  const newId = () => Math.max(0, ...all().map((m) => m.id)) + 1;

  k.route("POST", "/recordings/start", ({ body }) => {
    const b = (body ?? {}) as { title?: string; mode?: Meeting["mode"]; type?: string; name?: string; kind?: string; series?: string; app?: string };
    const ext = b.type?.includes("ogg") ? "ogg" : b.type?.includes("mp4") ? "m4a" : (b.name?.match(/\.(\w{2,4})$/)?.[1]?.toLowerCase() ?? "webm");
    const id = newId();
    const audio = `${id}.${ext}`;
    writeFileSync(join(dir, audio), "", { mode: 0o600 });
    const title = b.title?.trim() || (b.name ? b.name.replace(/\.\w+$/, "") : `${b.app ? `${b.app} meeting` : "Meeting"} ${new Date().toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`);
    const kind = kinds().some((x) => x.id === b.kind) ? b.kind : undefined;
    saveAll([{ id, title, named: !!b.title?.trim(), startedAt: Date.now(), mode: b.mode ?? "mic", status: "recording", audio, kind, series: b.series?.trim() || undefined, app: b.app }, ...all()]);
    const rid = `${id}-${Math.random().toString(36).slice(2, 8)}`;
    live.set(rid, { file: join(dir, audio), id, lastAt: Date.now(), heard: 0, segments: [], lastRun: 0, running: false });
    return { rid, id };
  });

  k.route("POST", "/recordings/:rid/chunk", ({ params, body }) => {
    const rec = live.get(params.rid);
    if (!rec) throw bad("that recording has already finished");
    const data = (body as { data?: string })?.data?.replace(/^data:[^,]*,/, "");
    if (!data) throw bad("no audio in this piece");
    appendFileSync(rec.file, Buffer.from(data, "base64"));
    rec.lastAt = Date.now();
    return { ok: true, stop: !!rec.stop };
  });

  async function finish(rid: string, cut = false) {
    const rec = live.get(rid);
    if (!rec) return;
    live.delete(rid);
    if (!existsSync(rec.file) || !statSync(rec.file).size) {
      update(rec.id, (x) => Object.assign(x, { status: "failed", error: "No audio arrived" }));
      return;
    }
    // a recording made in pieces has no index, so players can't seek in it; copying it once adds one
    if (rec.file.endsWith(".webm")) {
      const tmp = `${rec.file}.tmp.webm`;
      await k.run("ffmpeg", ["-y", "-v", "quiet", "-i", rec.file, "-c", "copy", tmp]).catch(() => undefined);
      if (existsSync(tmp) && statSync(tmp).size) renameSync(tmp, rec.file);
      else rmSync(tmp, { force: true });
    }
    // waits for a live pass still going, then only the rest needs transcribing
    while (rec.running) await new Promise((ok) => setTimeout(ok, 500));
    update(rec.id, (x) => Object.assign(x, { status: "transcribing", ...(cut ? { error: "The recording stopped early; this is what arrived" } : {}) }));
    transcribe(rec.id, rec.file, rec.heard, rec.segments).catch((e) => k.log("transcribe failed", (e as Error).message));
  }

  k.route("POST", "/recordings/:rid/finish", ({ params }) => {
    if (!live.has(params.rid)) throw bad("that recording has already finished");
    finish(params.rid).catch((e) => k.log("finish failed", (e as Error).message));
    return { ok: true };
  });

  k.route("POST", "/recordings/:rid/discard", ({ params }) => {
    const rec = live.get(params.rid);
    if (!rec) throw bad("that recording has already finished");
    live.delete(params.rid);
    remove(rec.id);
    return { ok: true };
  });

  // Stops a recording made somewhere else, like the desktop app's background recorder: its next piece of audio
  // hears it, and if nothing more comes the server finishes it anyway.
  k.route("POST", "/meetings/:id/stop", ({ params }) => {
    const id = Number(params.id);
    const found = [...live].find(([, r]) => r.id === id);
    if (!found) throw bad("it isn't recording");
    found[1].stop = true;
    setTimeout(() => live.has(found[0]) && finish(found[0]).catch(() => {}), 15_000);
    return { ok: true };
  });

  // Live captions: every few seconds the new audio is transcribed and what's settled is kept (the last couple of
  // seconds may be a word cut in half). At the end only what's left needs doing, so the summary comes quickly.
  async function follow(rec: Live) {
    rec.running = true;
    rec.lastRun = Date.now();
    try {
      const d = await hear(rec.file, rec.heard);
      if (d.error) return;
      const settled = d.segments.filter((s) => s.end <= d.duration - 2);
      if (!settled.length) return;
      rec.heard = Math.max(...settled.map((s) => s.end));
      rec.segments.push(...settled);
      saveText(rec.id, rec.segments);
      update(rec.id, (x) => (x.duration = rec.heard));
    } finally {
      rec.running = false;
    }
  }
  const timer = setInterval(() => {
    const captions = k.setting<boolean>("liveCaptions") !== false;
    for (const [rid, rec] of live) {
      if (Date.now() - rec.lastAt > 90_000) {
        k.log(`recording ${rid} stopped getting audio, finishing it`);
        finish(rid, true).catch(() => {});
      } else if (captions && !rec.running && rec.lastAt > rec.lastRun && Date.now() - rec.lastRun >= 10_000 && !find(rec.id)?.mode.startsWith("file"))
        follow(rec).catch((e) => k.log("live captions failed", (e as Error).message));
    }
  }, 2000);
  k.onStop(() => clearInterval(timer));

  // ---- meetings ----

  k.route("GET", "/meetings", ({ query }) => {
    const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const list = all().map((m) => ({ ...m, live: [...live.values()].some((r) => r.id === m.id) }));
    if (!words.length) return { meetings: list };
    // searches titles, summaries and what was said, and says where it matched
    return {
      meetings: list
        .map((m) => {
          const segs = readText(m.id);
          const hay = `${m.title}\n${JSON.stringify(m.summary ?? "")}\n${m.notes ?? ""}`.toLowerCase();
          const hit = segs.find((s) => words.every((w) => s.text.toLowerCase().includes(w)));
          const ok = words.every((w) => hay.includes(w) || segs.some((s) => s.text.toLowerCase().includes(w)));
          return ok ? { ...m, hit: hit ? { at: hit.start, text: hit.text } : undefined } : undefined;
        })
        .filter(Boolean),
    };
  });

  k.route("GET", "/meetings/:id", ({ params }) => {
    const m = find(Number(params.id));
    if (!m) throw bad("meeting not found", 404);
    return { ...m, live: [...live.values()].some((r) => r.id === m.id), segments: readText(m.id) };
  });

  k.route("PUT", "/meetings/:id", ({ params, body }) => {
    const b = (body ?? {}) as { title?: string; notes?: string; done?: { index: number; done: boolean }; kind?: string; series?: string };
    const m = update(Number(params.id), (x) => {
      if (b.title?.trim()) Object.assign(x, { title: b.title.trim(), named: true });
      if (typeof b.kind === "string") x.kind = kinds().some((y) => y.id === b.kind) ? b.kind : undefined;
      if (typeof b.series === "string") x.series = b.series.trim() || undefined;
      if (typeof b.notes === "string") x.notes = b.notes;
      const a = b.done && x.summary?.actions[b.done.index];
      if (a) a.done = b.done!.done;
    });
    if (!m) throw bad("meeting not found", 404);
    return m;
  });

  k.route("POST", "/meetings/:id/marks", ({ params, body }) => {
    const b = (body ?? {}) as { at?: number; text?: string };
    const m = update(Number(params.id), (x) => (x.marks = [...(x.marks ?? []), { at: Math.max(0, b.at ?? 0), text: (b.text ?? "").trim() }]));
    if (!m) throw bad("meeting not found", 404);
    return m;
  });

  k.route("POST", "/meetings/paste", ({ body }) => {
    const b = (body ?? {}) as { title?: string; transcript?: string; kind?: string; series?: string };
    const text = b.transcript?.trim();
    if (!text) throw bad("paste the transcript first");
    const id = newId();
    const kind = kinds().some((x) => x.id === b.kind) ? b.kind : undefined;
    saveAll([{ id, title: b.title?.trim() || "Pasted meeting", named: !!b.title?.trim(), startedAt: Date.now(), mode: "paste", status: "summarising", kind, series: b.series?.trim() || undefined }, ...all()]);
    saveText(id, text.split("\n").filter((l) => l.trim()).map((l, i) => ({ start: i, end: i, speaker: "", text: l.trim() })));
    summarise(id).catch((e) => k.log("summary failed", (e as Error).message));
    return { id };
  });

  k.route("POST", "/meetings/:id/summarise", ({ params }) => {
    const m = find(Number(params.id));
    if (!m) throw bad("meeting not found", 404);
    if (m.status === "recording" || m.status === "transcribing") throw bad("wait for the transcript first");
    if (m.status === "failed" && m.audio && !readText(m.id).length) {
      update(m.id, (x) => ((x.status = "transcribing"), delete x.error));
      transcribe(m.id, join(dir, m.audio), 0, []).catch((e) => k.log("transcribe failed", (e as Error).message));
    } else summarise(m.id).catch((e) => k.log("summary failed", (e as Error).message));
    return { ok: true };
  });

  function remove(id: number) {
    const m = find(id);
    if (m?.audio) rmSync(join(dir, m.audio), { force: true });
    rmSync(textFile(id), { force: true });
    saveAll(all().filter((x) => x.id !== id));
  }
  k.route("DELETE", "/meetings/:id", ({ params }) => {
    const id = Number(params.id);
    for (const [rid, rec] of live) if (rec.id === id) live.delete(rid);
    remove(id);
    return { ok: true };
  });

  // the recording, in ranges so the player can seek to a topic
  k.route("GET", "/meetings/:id/audio", ({ params, headers }) => {
    const m = find(Number(params.id));
    if (!m?.audio || !existsSync(join(dir, m.audio))) throw bad("no recording", 404);
    const buf = readFileSync(join(dir, m.audio));
    const type = m.audio.endsWith(".ogg") ? "audio/ogg" : m.audio.endsWith(".m4a") ? "audio/mp4" : m.audio.endsWith(".mp3") ? "audio/mpeg" : m.audio.endsWith(".wav") ? "audio/wav" : "audio/webm";
    const range = headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (!range) return new Response(buf, { headers: { "content-type": type, "accept-ranges": "bytes", "content-length": String(buf.length) } });
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : buf.length - 1, buf.length - 1);
    return new Response(buf.subarray(start, end + 1), { status: 206, headers: { "content-type": type, "content-range": `bytes ${start}-${end}/${buf.length}` } });
  });

  // a Claude session with the whole meeting in front of it, to ask anything about it
  k.route("POST", "/meetings/:id/ask", ({ params, body }) => {
    const m = find(Number(params.id));
    if (!m) throw bad("meeting not found", 404);
    const file = join(dir, `${m.id}.md`);
    const s = m.summary;
    writeFileSync(file, [`# ${m.title}`, new Date(m.startedAt).toString(), s ? `\n## Summary\n${s.tldr}` : "", m.notes ? `\n## My notes\n${m.notes}` : "", `\n## Transcript\n${asText(readText(m.id), true)}`].join("\n"), { mode: 0o600 });
    const ask = ((body ?? {}) as { prompt?: string }).prompt?.trim();
    const cwd = home(k.setting<string>("cwd") || "~");
    const term = k.claude({ cwd: existsSync(cwd) ? cwd : homedir(), title: `meeting · ${m.title}`, prompt: `Read the meeting in ${file} (its transcript has [mm:ss] times and comes from speech recognition, so some words are misheard). ${ask || "Then wait for my questions about it."}` });
    return { term: term.id };
  });

  k.route("GET", "/kinds", () => kinds().map(({ id, name }) => ({ id, name })));

  // What the desktop app needs to start and stop recordings by itself: whether to, and which apps are meetings.
  // An app matches when its macOS bundle id or Linux program name contains the part before "=".
  k.route("GET", "/auto", () => ({
    mode: k.setting<string>("autoRecord") || "ask",
    apps: (k.setting<string[]>("meetingApps") ?? [])
      .map((l) => l.split("="))
      .filter(([m, n]) => m?.trim() && n?.trim())
      .map(([m, n]) => ({ match: m.trim().toLowerCase(), name: n.trim() })),
  }));

  // ---- setup: a Python with faster-whisper, on the GPU when there is one ----

  // Meetings owns the Whisper setup; other plugins that transcribe on this machine (a call recorder, say) read it
  // here and run the same transcribe.py, with their own speaker names
  k.route("GET", "/whisper", () => ({ python: python(), model: k.setting<string>("whisperModel") || "large-v3-turbo", script: join(here, "transcribe.py"), ready: existsSync(python()) }));

  // checked and set up where transcription runs, which may be another machine
  const setupState = async () => {
    const py = python();
    const ffmpeg = await k.run("ffmpeg", ["-version"]).then(() => true, () => false);
    const ready = existsSync(py) && (await k.run(py, ["-c", "import faster_whisper"]).then(() => true, () => false));
    return { ready, ffmpeg, python: py };
  };
  k.expose("setupState", setupState);
  k.route("GET", "/setup", async () => {
    const on = k.where("whisper");
    return on ? { ...(await k.remote(on).call<object>("setupState")), on } : setupState();
  });

  k.expose("setup", () => setUp());
  k.route("POST", "/setup", async () => {
    const on = k.where("whisper");
    return on ? k.remote(on).call("setup") : setUp();
  });
  async function setUp() {
    const py = python();
    const venv = dirname(dirname(py));
    const gpu = await k.run("nvidia-smi", ["-L"]).then(() => true, () => false);
    const extra = gpu ? " nvidia-cublas-cu12 nvidia-cudnn-cu12" : "";
    const cmd = `command -v uv >/dev/null || { echo "Needs uv: https://docs.astral.sh/uv/"; exit 1; }; uv venv --python 3.12 ${q(venv)} && uv pip install --python ${q(py)} faster-whisper${extra}`;
    k.job("set up meeting transcription", cmd).then((r) => k.notify({ title: r.code ? "Transcription setup failed" : "Transcription is ready", body: r.code ? "See the job log" : "Meetings can be recorded and summarised now", link: "/p/meetings/meetings" }));
    return { ok: true };
  }
}
