import type { Cockpit, Ticket, TrackerSprint, TrackerTicket } from "@cockpit/shared";

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

  const myTickets = (force = false) =>
    k.cache(
      "mine",
      LONG,
      async (): Promise<Ticket[]> => {
        const [sprint, other] = await Promise.all([
          search("assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC", true),
          search("assignee = currentUser() AND statusCategory != Done AND status != Archived AND (sprint is EMPTY OR sprint not in openSprints()) ORDER BY updated DESC", false),
        ]);
        return [...sprint, ...other];
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
    async assignToMe(key) {
      await k.run("acli", ["jira", "workitem", "assign", "--key", key, "--assignee", "@me"]);
      await myTickets(true);
    },
    sprints,
    activeSprint,
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
    async epicInfo(key) {
      const raw = await acli(["workitem", "view", key, "--fields", "summary,issuetype"]);
      return { key: raw.key as string, summary: (raw.fields?.summary ?? "") as string, isEpic: raw.fields?.issuetype?.name === "Epic" };
    },
  });
}
