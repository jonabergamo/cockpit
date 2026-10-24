import type { Cockpit, NewTicket, Ticket, TrackerSprint, TrackerTicket } from "@cockpit/shared";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Jira through Atlassian's acli. Everything is cached for long and only fetched again when a screen asks
// for fresh data, since every call is a subprocess and a network round trip.
const LONG = 12 * 3600_000;
const DAY = 24 * 3600_000;
const LIST_FIELDS = "summary,status,issuetype,assignee";

// `acli --paginate --json` prints one JSON document per page, back to back
export function parseConcat(text: string): any[] {
  const out: any[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") {
      if (depth++ === 0) start = i;
    } else if ((ch === "}" || ch === "]") && --depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
  }
  return out;
}

// Jira wants rich text as Atlassian Document Format: paragraphs, or a bullet list for lines like criteria
const text = (t: string) => [{ type: "text", text: t }];
export const adf = (body: string) => ({ type: "doc", version: 1, content: body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => ({ type: "paragraph", content: text(p) })) });
export const adfList = (lines: string[]) => ({ type: "doc", version: 1, content: [{ type: "bulletList", content: lines.map((l) => ({ type: "listItem", content: [{ type: "paragraph", content: text(l) }] })) }] });

export interface CreateConfig {
  project: string;
  // values a project requires, by preset name, as Jira field ids to values
  presets: Record<string, Record<string, unknown>>;
  acField?: string;
  pointsField?: string;
  sprintField?: string;
  epicField?: string;
  sprintId?: number;
}

// what acli's --from-json takes for a new work item; custom fields can only be set here, at creation
export function createJson(t: NewTicket, c: CreateConfig) {
  const extra: Record<string, unknown> = { ...(t.preset ? c.presets[t.preset] : Object.values(c.presets)[0]) };
  const ac = String(t.fields?.ac ?? "").split("\n").map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
  if (c.acField && ac.length) extra[c.acField] = adfList(ac);
  if (c.pointsField && t.fields?.points !== undefined && t.fields.points !== "") extra[c.pointsField] = Number(t.fields.points);
  if (c.sprintField && t.inSprint && c.sprintId) extra[c.sprintField] = c.sprintId;
  if (c.epicField && t.parent) extra[c.epicField] = t.parent;
  return {
    projectKey: c.project,
    type: t.type || "Task",
    summary: t.summary,
    ...(t.description?.trim() ? { description: adf(t.description) } : {}),
    ...(Object.keys(extra).length ? { additionalAttributes: extra } : {}),
  };
}

export default function setup(k: Cockpit) {
  const s = <T>(key: string) => k.setting<T>(key);
  const acli = async (args: string[]) => JSON.parse(await k.run("acli", ["jira", ...args, "--json"]));
  const acliPages = async (args: string[]) => parseConcat(await k.run("acli", ["jira", ...args, "--json"]));

  const site = () =>
    k.cache("site", DAY, async () => {
      const m = (await k.run("acli", ["jira", "auth", "status"])).match(/Site:\s*(\S+)/)?.[1];
      return m ? `https://${m}` : "";
    });

  const boardId = () =>
    k.cache(`board:${s("board")}`, DAY, async () => {
      if (!s("board")) throw Object.assign(new Error("set the board name in Settings → Plugins → Jira"), { status: 400 });
      return (await acli(["board", "search", "--name", s<string>("board")])).values?.[0]?.id as number;
    });

  // the project new tickets go in: the setting, else the one the board belongs to ("Acme (ACME)")
  const projectKey = () =>
    k.cache(`project:${s("board")}:${s("project")}`, DAY, async () => {
      if (s<string>("project")) return s<string>("project");
      if (!s("board")) throw Object.assign(new Error("set the board, or the project for new tickets, in Settings → Plugins → Jira"), { status: 400 });
      const loc = String((await acli(["board", "search", "--name", s<string>("board")])).values?.[0]?.location ?? "");
      const key = loc.match(/\(([A-Z][A-Z0-9]+)\)\s*$/)?.[1];
      if (!key) throw Object.assign(new Error("couldn't tell the board's project; set the project for new tickets in Settings → Plugins → Jira"), { status: 400 });
      return key;
    });

  const points = () => s<string>("pointsField") || "customfield_10016";
  const fields = () => `summary,status,issuetype,assignee,parent,created,resolutiondate,statuscategorychangedate,${points()}`;

  function toTicket(raw: any, url: string, inSprint: boolean): TrackerTicket {
    const f = raw.fields ?? {};
    return {
      key: raw.key,
      summary: f.summary ?? "",
      status: f.status?.name ?? "",
      statusCategory: f.status?.statusCategory?.key,
      type: f.issuetype?.name,
      points: f[points()] ?? undefined,
      assignee: f.assignee?.displayName,
      priority: f.priority?.name,
      inSprint,
      url: url ? `${url}/browse/${raw.key}` : undefined,
      created: f.created,
      parent: f.parent?.key,
      parentSummary: f.parent?.fields?.summary,
      parentStatus: f.parent?.fields?.status?.name,
      parentType: f.parent?.fields?.issuetype?.name,
      statusChangedAt: f.statuscategorychangedate,
      resolvedAt: f.resolutiondate ?? undefined,
    };
  }

  const sprints = () =>
    k.cache("sprints", 3600_000, async () => {
      const pages = await acliPages(["board", "list-sprints", "--id", String(await boardId()), "--paginate"]);
      return pages.flatMap((p) => p.sprints ?? []).map((x: any): TrackerSprint => ({ id: x.id, name: x.name, start: x.startDate, end: x.endDate, goal: x.goal, state: x.state }));
    });
  const activeSprint = async () => (await sprints()).find((x) => x.state === "active");

  // six at a time, since the sprint listing can't return custom fields like points
  async function viewMany(keys: string[]) {
    const out: any[] = [];
    const queue = [...keys];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let key = queue.shift(); key; key = queue.shift()) {
          try {
            out.push(await acli(["workitem", "view", key, "--fields", fields()]));
          } catch {
            // deleted, or no access
          }
        }
      }),
    );
    return out;
  }

  async function search(jql: string, inSprint: boolean, extra = "") {
    const res = await acli(["workitem", "search", "--jql", jql, "--fields", LIST_FIELDS + extra, "--limit", "100"]);
    const items: any[] = Array.isArray(res) ? res : (res.issues ?? []);
    const url = await site();
    return items.map((i) => toTicket(i, url, inSprint));
  }

  // Search can't return the parent field, so each ticket's epic comes from its own view, kept a day per ticket
  // since a ticket rarely changes epics, even on a forced refresh. The epic's status can be a day old here.
  async function withParents(list: TrackerTicket[]): Promise<TrackerTicket[]> {
    const queue = list.filter((t) => !t.parent).map((t) => t.key);
    const found = new Map<string, any>();
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let key = queue.shift(); key; key = queue.shift()) {
          const k2 = key;
          const parent = await k.cache(`parent:${k2}`, DAY, async () => (await acli(["workitem", "view", k2, "--fields", "parent"])).fields?.parent ?? null).catch(() => null);
          if (parent) found.set(k2, parent);
        }
      }),
    );
    return list.map((t) => {
      const p = found.get(t.key);
      return p ? { ...t, parent: p.key, parentSummary: p.fields?.summary, parentStatus: p.fields?.status?.name, parentType: p.fields?.issuetype?.name } : t;
    });
  }

  const myTickets = (force = false) =>
    k.cache(
      "mine",
      LONG,
      async (): Promise<Ticket[]> => {
        const [sprint, other] = await Promise.all([
          search("assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC", true),
          search("assignee = currentUser() AND statusCategory != Done AND status != Archived AND (sprint is EMPTY OR sprint not in openSprints()) ORDER BY updated DESC", false),
        ]);
        return withParents([...sprint, ...other]);
      },
      force,
    );

  const keysKey = (keys: string[]) => [...new Set(keys)].sort().join(",");

  k.tracker({
    name: "Jira",
    get keyPattern() {
      return s<string>("keyPattern") || undefined;
    },
    statusConfig: () => ({
      statusOrder: s<string[]>("statusOrder") ?? [],
      releasedStatuses: s<string[]>("releasedStatuses") ?? [],
      doneStatuses: s<string[]>("doneStatuses") ?? [],
      buckets: (s<Record<string, string[]>>("buckets") ?? {}) as Record<string, string[]>,
    }),
    isMine: (t) => !s("assignee") || t.assignee === s("assignee"),
    me: () => s<string>("assignee") || undefined,
    myTickets,
    statusesOf: (keys, force) => k.cache(`statuses:${keysKey(keys)}`, LONG, () => search(`key in (${keysKey(keys)})`, false), force),
    // any JQL; the support queue uses this
    search: (jql, force) => k.cache(`search:${jql}`, LONG, () => search(jql, false, ",priority"), force),
    // searches can't return custom fields, so each ticket is viewed for its points, kept a few hours
    async pointsOf(keys, force = false) {
      const out: Record<string, number | null> = {};
      const queue = [...new Set(keys)];
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          for (let key = queue.shift(); key; key = queue.shift()) {
            const k2 = key;
            try {
              const v = await k.cache(`points:${k2}:${points()}`, 6 * 3600_000, async () => (await acli(["workitem", "view", k2, "--fields", points()])).fields?.[points()] ?? null, force);
              out[k2] = typeof v === "number" ? v : null;
            } catch (e) {
              // left out, so the screen can say it couldn't read them rather than that there are none
              k.log(`points of ${k2}`, (e as Error).message);
            }
          }
        }),
      );
      return out;
    },
    async assignToMe(key) {
      await k.run("acli", ["jira", "workitem", "assign", "--key", key, "--assignee", "@me"]);
      await myTickets(true);
    },
    sprints,
    activeSprint,
    // JQL keeps every status change, so a past day's answer never changes; today's can
    async inStatusOn(sprintId, statuses, day) {
      const list = statuses.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(", ");
      const past = day < new Date().toISOString().slice(0, 10);
      return k.cache(`was:${sprintId}:${day}:${statuses.join("|")}`, past ? 30 * 24 * 3600_000 : 10 * 60_000, async () => {
        const res = await acli(["workitem", "search", "--jql", `sprint = ${sprintId} AND status WAS IN (${list}) ON "${day} 23:59"`, "--fields", "summary", "--limit", "500"]);
        const items: any[] = Array.isArray(res) ? res : (res.issues ?? []);
        return items.map((i) => i.key as string);
      });
    },
    async sprintTickets(sprintId, force = false, maxAge = LONG) {
      const id = sprintId ?? (await activeSprint())?.id;
      if (!id) return [];
      return k.cache(
        `sprint:${id}`,
        maxAge,
        async () => {
          const pages = await acliPages(["sprint", "list-workitems", "--board", String(await boardId()), "--sprint", String(id), "--paginate", "--fields", "key"]);
          const url = await site();
          return (await viewMany(pages.flatMap((p) => p.issues ?? []).map((i: any) => i.key))).map((r) => toTicket(r, url, true));
        },
        force,
      );
    },
    // epics that have their own worktree; their tickets are stacked on the epic branch. Search can't return a
    // ticket's parent, so ask which worktree tickets are epics, then one search per epic for my tickets in it.
    worktreeEpics: (keys, force) =>
      k.cache(
        `epics:${keysKey(keys)}`,
        LONG,
        async () => {
          const epics = await search(`key in (${keysKey(keys)}) AND issuetype = Epic`, false);
          return Promise.all(epics.map(async (e) => ({ ...e, children: (await search(`parent = ${e.key} AND assignee = currentUser() ORDER BY created ASC`, false)).map((t) => t.key) })));
        },
        force,
      ),
    async createOptions() {
      const ac = s<string>("acField");
      return {
        types: s<string[]>("createTypes")?.length ? s<string[]>("createTypes") : ["Task", "Story", "Bug"],
        presets: Object.keys(s<Record<string, unknown>>("createPresets") ?? {}),
        fields: [
          ...(ac ? [{ key: "ac", label: "Acceptance criteria", kind: "lines" as const }] : []),
          { key: "points", label: "Story points", kind: "number" as const },
        ],
        sprint: !!s<string>("sprintField"),
      };
    },
    // made from a JSON file, since only that sets custom fields; then assigned to you, since the file's assignee
    // wants an account id
    async createTicket(t) {
      const sprintId = t.inSprint ? (await activeSprint())?.id : undefined;
      const body = createJson(t, {
        project: await projectKey(),
        presets: s<Record<string, Record<string, unknown>>>("createPresets") ?? {},
        acField: s<string>("acField") || undefined,
        pointsField: points(),
        sprintField: s<string>("sprintField") || undefined,
        epicField: s<string>("epicField") || undefined,
        sprintId,
      });
      const file = join(k.dataDir, `new-ticket-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(body));
      let out: string;
      try {
        out = await k.run("acli", ["jira", "workitem", "create", "--from-json", file, "--json"]);
      } finally {
        rmSync(file, { force: true });
      }
      const key = (() => {
        try {
          return JSON.parse(out).key as string;
        } catch {
          return out.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];
        }
      })();
      if (!key) throw new Error(`Jira didn't say which ticket it made: ${out.slice(0, 200)}`);
      await k.run("acli", ["jira", "workitem", "assign", "--key", key, "--assignee", "@me"]).catch(() => {});
      await myTickets(true).catch(() => []);
      const made = (await search(`key = ${key}`, !!sprintId).catch(() => []))[0];
      return made ?? { key, summary: t.summary, status: "To Do", inSprint: !!sprintId };
    },
    async epicInfo(key) {
      const raw = await acli(["workitem", "view", key, "--fields", "summary,issuetype"]);
      return { key: raw.key as string, summary: (raw.fields?.summary ?? "") as string, isEpic: raw.fields?.issuetype?.name === "Epic" };
    },
  });
}
