import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Cockpit } from "@cockpit/shared";

interface Project {
  id: string;
  name: string;
  description?: string;
  // where Claude works when planning one of its ideas, like the project's repo
  folder?: string;
  createdAt: number;
}

interface Idea {
  id: string;
  project?: string;
  title: string;
  // Markdown
  notes?: string;
  status: string;
  // a heading to group ideas under, like "Reorder and retention"
  group?: string;
  // when it's meant to happen, like "Phase 2"
  phase?: string;
  estimate?: string;
  tags?: string[];
  // its number in a list it came from, or a ticket key
  ref?: string;
  // where it came from, like a link to a doc
  source?: string;
  createdAt: number;
  updatedAt: number;
}

const fields = ["title", "notes", "status", "group", "phase", "estimate", "tags", "ref", "source", "project"] as const;

export default function setup(k: Cockpit) {
  const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
  const projects = () => k.store.get<Project[]>("projects") ?? [];
  const ideas = () => k.store.get<Idea[]>("ideas") ?? [];
  const saveProjects = (list: Project[]) => k.store.set("projects", list);
  const saveIdeas = (list: Idea[]) => k.store.set("ideas", list);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const statuses = () => {
    const s = k.setting<string[]>("statuses");
    return Array.isArray(s) && s.length ? s : ["Inbox", "Planned", "Doing", "Done", "Dropped"];
  };

  k.screen({ id: "ideas", title: "Ideas", page: "assets/index.html" });

  // a project by id, or by name, made when it's new, so a Claude session can just name one
  function projectOf(p?: string) {
    if (!p?.trim()) return undefined;
    const list = projects();
    const found = list.find((x) => x.id === p || x.name.toLowerCase() === p.trim().toLowerCase());
    if (found) return found.id;
    const made = { id: newId(), name: p.trim(), createdAt: Date.now() };
    saveProjects([...list, made]);
    return made.id;
  }

  function clean(body: Partial<Idea>, base?: Idea): Idea {
    const now = Date.now();
    const out: Idea = base ? { ...base } : { id: newId(), title: "", status: statuses()[0], createdAt: now, updatedAt: now };
    for (const f of fields) {
      if (!(f in body)) continue;
      const v = body[f];
      if (f === "tags") out.tags = (Array.isArray(v) ? v : String(v ?? "").split(",")).map((t) => String(t).trim()).filter(Boolean);
      else if (f === "project") out.project = projectOf(v as string);
      else if (v === null || v === "") delete out[f];
      else (out as unknown as Record<string, unknown>)[f] = String(v);
    }
    if (!out.title.trim()) throw bad("an idea needs a title");
    out.title = out.title.trim();
    out.updatedAt = now;
    return out;
  }

  k.route("GET", "/data", () => ({ projects: projects(), ideas: ideas(), statuses: statuses() }));

  k.route("POST", "/ideas", ({ body }) => {
    const idea = clean((body ?? {}) as Partial<Idea>);
    saveIdeas([idea, ...ideas()]);
    return idea;
  });

  // many at once, for importing a list; ideas with the same project and title are updated, not doubled
  k.route("POST", "/import", ({ body }) => {
    const b = (body ?? {}) as { project?: string; ideas?: Partial<Idea>[] };
    if (!Array.isArray(b.ideas)) throw bad("send ideas: [...]");
    const project = projectOf(b.project);
    const list = ideas();
    let added = 0, updated = 0;
    for (const raw of b.ideas) {
      const p = raw.project ? projectOf(raw.project) : project;
      const same = list.find((x) => x.project === p && x.title.toLowerCase() === String(raw.title ?? "").trim().toLowerCase());
      const idea = clean({ ...raw, project: undefined }, same);
      idea.project = p;
      if (same) Object.assign(same, idea), updated++;
      else list.push(idea), added++;
    }
    saveIdeas(list);
    return { added, updated };
  });

  k.route("PUT", "/ideas/:id", ({ params, body }) => {
    const list = ideas();
    const i = list.findIndex((x) => x.id === params.id);
    if (i < 0) throw bad("idea not found", 404);
    list[i] = clean((body ?? {}) as Partial<Idea>, list[i]);
    saveIdeas(list);
    return list[i];
  });

  k.route("DELETE", "/ideas/:id", ({ params }) => {
    saveIdeas(ideas().filter((x) => x.id !== params.id));
    return { ok: true };
  });

  k.route("POST", "/projects", ({ body }) => {
    const b = (body ?? {}) as Partial<Project>;
    if (!b.name?.trim()) throw bad("a project needs a name");
    if (projects().some((x) => x.name.toLowerCase() === b.name!.trim().toLowerCase())) throw bad("there's a project with that name already");
    const p: Project = { id: newId(), name: b.name.trim(), description: b.description?.trim() || undefined, folder: b.folder?.trim() || undefined, createdAt: Date.now() };
    saveProjects([...projects(), p]);
    return p;
  });

  k.route("PUT", "/projects/:id", ({ params, body }) => {
    const b = (body ?? {}) as Partial<Project>;
    const list = projects();
    const p = list.find((x) => x.id === params.id);
    if (!p) throw bad("project not found", 404);
    if (b.name?.trim()) p.name = b.name.trim();
    for (const f of ["description", "folder"] as const) if (typeof b[f] === "string") p[f] = b[f]!.trim() || undefined;
    saveProjects(list);
    return p;
  });

  // a project goes, its ideas stay, without a project
  k.route("DELETE", "/projects/:id", ({ params }) => {
    saveProjects(projects().filter((x) => x.id !== params.id));
    saveIdeas(ideas().map((x) => (x.project === params.id ? { ...x, project: undefined } : x)));
    return { ok: true };
  });

  // Claude, in the project's folder, with the idea in front of it
  k.route("POST", "/ideas/:id/plan", ({ params }) => {
    const idea = ideas().find((x) => x.id === params.id);
    if (!idea) throw bad("idea not found", 404);
    const p = projects().find((x) => x.id === idea.project);
    const folder = p?.folder?.replace(/^~/, homedir());
    const text = [`# ${idea.title}`, [idea.ref && `Ref ${idea.ref}`, idea.group, idea.phase, idea.estimate && `Estimate ${idea.estimate}`].filter(Boolean).join(" · "), idea.notes].filter(Boolean).join("\n\n");
    const prompt = (k.setting<string>("planPrompt") || "Help me plan this idea for {project}.\n\n{idea}").replace("{project}", p?.name ?? "me").replace("{idea}", text);
    const term = k.claude({ cwd: folder && existsSync(folder) ? folder : homedir(), title: `idea · ${idea.title.slice(0, 40)}`, prompt });
    return { term: term.id };
  });
}
