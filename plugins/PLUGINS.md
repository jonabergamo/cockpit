# Writing a cockpit plugin

A plugin is a folder with a `plugin.json`. It can add screens, themes, API routes, listeners and Claude Code skills, and it can plug in a work tracker, a code host or a way in from other machines. This guide is for people and for AI assistants writing one.

## Where plugins live

- `plugins/` in this repo holds the bundled ones. They start on unless their manifest says `"defaultOn": false`.
- Your own go in the plugins folder. That's `pluginsDir` in `config.local.toml`, or `data/plugins` if you leave it unset. They start off until you turn them on in Settings → Plugins.
- Settings → Plugins can also install one from a git link (https, ssh, or `owner/name` for GitHub), with a folder in the repo and a branch or tag when you need them. It clones the repo and shows what the plugin asks for and which parts of the API its code calls before anything runs, then copies it into the plugins folder pinned to that commit, off. Where it came from is kept in `.cockpit-source.json` in its folder, which is how Check for an update and Remove know it.
- A plugin of yours with the same id as a bundled one replaces it.
- Folders whose names start with `.` or `_` are skipped.

Cockpit watches both folders. Saving a file reloads that plugin, and adding or removing a `plugin.json` refreshes the list. Only `server.ts` itself is imported fresh on reload. If it imports other files of yours, restart cockpit after changing them.

## The folder

```
my-plugin/
  plugin.json     required
  server.ts       optional: code that runs in the cockpit server (server.js and server.mjs work too)
  themes/*.json   optional: one theme per file
  assets/         optional: pages and files for your screens
  skills/<name>/  optional: Claude Code skills that ship with the plugin, each with a SKILL.md
```

A plugin with only `plugin.json` and `themes/` runs no code, and Settings says so.

## plugin.json

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "api": 1,
  "description": "One line for the Settings card.",
  "author": "You",
  "homepage": "https://example.com",
  "settings": [
    { "key": "greeting", "label": "Greeting", "type": "text", "default": "Hello" },
    { "key": "token", "label": "API token", "type": "secret", "env": "MY_TOKEN", "help": "From your account page" }
  ]
}
```

- `id` uses lowercase letters, numbers and dashes, and must match the folder name.
- `api` is the plugin API version you wrote against. Cockpit refuses a plugin that asks for a newer one than it has.
- Setting types are `text`, `secret`, `bool`, `choice` (with `choices`), `number`, `list` (an array of strings, edited one per line) and `json` (any JSON value). Settings → Plugins draws a form from them, and the values are stored in cockpit's database, not in your folder.
- A `secret` never goes back to the browser in full: the form shows `••••` and the last four characters.
- `env` passes the setting to every command you start with `k.run`, as that environment variable. This is how a token entered in Settings reaches a CLI.
- `nodes: true` means the plugin also runs on the hub's nodes (see Settings → Machines). The hub copies the plugin's on/off state and settings to each node, so work it sends there, like transcription, finds the plugin set up the same way.
- `moved` lists the screens your plugin no longer has, by id, each with the cockpit path that replaced it, for example `"moved": { "old-screen": "/p/other/screen?tab=x" }`. Old links and saved notifications to `/p/<id>/old-screen` then go to that path, and keep their query.

Cockpit reads the manifest without running your code, so a plugin that fails to load still shows in Settings, with its error.

### requires

List the tools your plugin needs, and Settings → Setup checks them:

```json
"requires": [
  {
    "id": "gh",
    "name": "GitHub CLI (gh)",
    "check": ["gh", "--version"],
    "auth": ["gh", "auth", "status"],
    "login": ["gh", "auth", "login"],
    "install": { "linux": "see https://cli.github.com", "darwin": "brew install gh" },
    "docs": "https://cli.github.com",
    "settings": ["token"]
  }
]
```

- `check` succeeding means the tool is there, and the first line of its output is shown as the version.
- `auth` succeeding means it's logged in.
- `login` runs in a cockpit terminal, since logins are interactive.
- `install` runs as a job, but only if it needs no sudo or package manager. Otherwise Setup shows the command to copy.
- `settings` lists the secret settings that can stand in for a login, like a token. They're shown under the tool.
- Checks run with your `env` settings set, so a token you entered counts.

## server.ts

```ts
import type { Cockpit } from "@cockpit/shared";

export default function setup(k: Cockpit) {
  k.screen({ id: "main", title: "My plugin", page: "assets/index.html" });
  k.route("GET", "/items", async () => ({ items: k.store.get("items") ?? [] }));
  k.on("session.waiting", (s) => k.log("a session needs you", s));
}
```

`setup` can be async. If it throws, the plugin is marked as an error, everything it registered is dropped and the rest of cockpit carries on. Everything a plugin registers is also dropped when it's turned off or reloaded. Use `k.onStop(fn)` to clear timers or close connections.

What `k` offers:

| | |
|---|---|
| `k.id`, `k.dataDir`, `k.assetsDir` | Your id. A folder for your files, kept out of your plugin folder. Your `assets/` folder. |
| `k.setting(key)` | A setting's value, or its default. |
| `k.log(...)` | A line in your log, shown in Settings. The last 200 lines are kept. |
| `k.store.get(key)` / `k.store.set(key, value)` | Small JSON values kept in cockpit's database. |
| `k.route(method, path, handler)` | Serves `/api/plugins/<id>/x<path>`. `:name` parts end up in `params`. The handler gets `{ query, body, params, headers }` and returns JSON-able data, or a `Response` for anything else, like audio or a file. To send a 400, throw an `Error` with `status: 400`. |
| `k.screen({ id, title, page, settings })` | Adds a screen to the sidebar and ⌘K, at `/p/<id>/<screen>`. `page` is a file in your folder. With `settings: true` it's a page of settings instead: it's listed on the Settings page, not in the sidebar, and ⌘K still finds it. |
| `k.theme(theme)` | Adds a theme from code, for themes you generate. Static ones go in `themes/`. |
| `k.on(event, fn)` | `session.started`, `session.waiting` (Claude asked you something: a question, a permission prompt, a dialog), `session.idle` (it finished its turn), `session.ended`, `session.stuck`, `worktree.created`, `worktree.removed`, `terminal.opened`, `terminal.exited` (`{ id, code, run }`), `notify`, `task.started`, `task.done`, `autopilot.acted`, `verify.done`, `run.started` and `run.done` (each with the run). |
| `k.run(cmd, args, { cwd, input })` | Runs a command and resolves with its output, with your `env` settings set. |
| `k.terminal({ cwd, title, command, args, run })` | Opens a cockpit terminal. With `run: { kind, name, ticket }`, its command is recorded as a run with its output and exit code, and the result has the run's id as `runId`. |
| `k.claude({ cwd, prompt, title })` | Starts Claude in a terminal. |
| `k.notify({ title, body, link, urgent })` | Shows a cockpit notification. `urgent` marks the second nudge for a session left waiting, and autopilot giving up. |
| `k.sendToSession(sessionId, text)` | Types a message into a running Claude session and presses Enter. Resolves to `false` when the session isn't in a cockpit terminal. |
| `k.task({ title, prompt, ticket, attempts, model, dependsOn })` | Queues work: cockpit creates a worktree and branch, then starts Claude there with the prompt. Resolves with the tasks it created. |
| `k.job(label, command, cwd)` | Runs a shell command as a cockpit job, so its output shows in the job log. Resolves with the exit code and output. |
| `k.where(cap)` | The machine a kind of work is set to run on in Settings → Machines: `"headless"` (claude -p) or `"whisper"`. Returns a machine's id, or `undefined` for this machine. |
| `k.expose(name, fn)` | Lets this plugin call `fn` from another machine. `fn` gets the arguments and the files sent with the call, as paths on its own machine. |
| `k.remote(machine).call(name, args, { files, timeoutMs })` | Calls what this plugin exposed on another machine, where it runs too (see `nodes`). `files` maps names to paths here. They're copied first, and a file that only grew since the last call sends just the new part. |
| `k.sessions({ liveOnly, limit })`, `k.terminals()` | The Claude sessions and terminals cockpit knows about. |
| `k.cache(key, maxAge, fn, force)` | Runs `fn` and keeps its result for `maxAge` ms in cockpit's cache. `force` runs it again. |
| `k.runs` | Records runs on the Runs screen and reads them back. See [Runs](#runs). |
| `k.runPanel({ kinds, page, steps, meta })` | Adds a panel of yours to the page of each run of these kinds. With `meta`, only to runs that have that field in their meta. See [Runs](#runs). |
| `k.runOptions({ list, start })` | Adds to what "Run something" on the Runs screen offers for a worktree. See [Run something](#run-something). |
| `k.badge(screenId, badge)` | Shows a badge next to one of your screens in the sidebar. See [Sidebar badges](#sidebar-badges). |
| `k.ticketOf(...strings)` | Finds a ticket key in branch names or titles, using the active tracker's pattern. |
| `k.productionBranch()` | The branch that is production, as set on the Sprint report. It's empty when nobody has set it. |
| `k.tracker(provider)`, `k.codeHost(provider)` | Plugs a work tracker or a code host into cockpit. See below. |
| `k.reviewSource(provider)` | Adds PRs to the PR reviews queue without replacing the code host. See below. |
| `k.agent(provider)` | Adds a coding agent that tasks can be handed to. See below. |
| `k.access(provider)` | Decides which requests from other machines get in. See below. |
| `k.providers.tracker()`, `k.providers.codeHost()` | The ones in use, possibly from other plugins. |

Types for all of this are in `shared/src/plugin.ts`.

## Trackers and code hosts

Cockpit's Tickets, Sprint report and PR reviews screens, the ticket and PR parts of Today and Worktrees, and the worktree cleaner all go through two providers. The bundled `jira` and `github` plugins are the reference ones. Write your own to bring Linear, GitLab or anything else.

```ts
k.tracker({
  name: "Linear",
  keyPattern: "[A-Z]+-\\d+",
  statusConfig: () => ({ statusOrder: ["Todo", "In Progress", "Done"], releasedStatuses: ["Done"], doneStatuses: [], buckets: {} }),
  isMine: (t) => t.assignee === k.setting("me"),
  myTickets: async () => [/* Ticket[] */],
  statusesOf: async (keys) => [/* Ticket[] for those keys */],
});
```

- A tracker only needs `myTickets` and `statusesOf`. The rest are optional and turn on more of cockpit:
  - `sprints`, `activeSprint` and `sprintTickets` give you the Sprint report and its snapshots.
  - `worktreeEpics` and `epicInfo` give you epics.
  - `search` and `assignToMe` let other plugins build queues.
  - `pointsOf` reads story points for tickets your searches return without them. Leave out a key whose points couldn't be read, so a screen can show them as unknown instead of missing.
- A code host needs `myPrs`. Add `reviewThreads` so autopilot and the lead session can quote unresolved review comments. Add `reviewQueue`, `failingChecks`, `parsePr`, `prInfo`, `pendingReview` and `deletePending` for PR reviews and for fixing failed checks with Claude. Fill `reviewers` on each PR and add `requestReview` so the Board can say who a PR waits on, and autopilot can ask for another review once its fix is pushed. Add `lastReview` (your last submitted review of a PR, the commit it was on, what changed since and your comments) for "Review what changed" on PR reviews. A task can start on top of someone's open PR when `prInfo` gives `headRefName`, `headRefOid` and `baseRefName`.
- The shapes are in `shared/src/plugin.ts` (`Tracker`, `CodeHost`). Tickets and PRs use the same `Ticket` and `PullRequest` types the screens already read.
- Only one of each is in use at a time. If two plugins offer one, Settings lets you pick. With none, the screens that need it leave the sidebar.

## More PRs to review

The PR reviews screen lists what is waiting for your review, from the code host's own queue. If something else
decides who reviews what, a rota or a board of your own, add it to that list instead of replacing the code host:

```ts
k.reviewSource({
  name: "Our rota",
  queue: async (fresh) => [/* PullRequest[] */],
});
```

- Every plugin that offers one counts, unlike the tracker and the code host where only one is in use.
- The lists are merged oldest first, and a PR in two of them is shown once, with the code host's version of it.
- A source that throws is left out and logged, so one being unreachable does not empty the screen.
- `fresh` is true when you press Refresh. Cache the rest of the time: this is called whenever the screen loads.
- The rows are ordinary `PullRequest` values, so `url` has to be a real PR the code host can open, or Claude
  has nothing to review.
- Add `reviewersOf(fresh)` to say who it put on your own PRs, as `{ url, reviewers }` rows. They join the code
  host's reviewers, so the Board can say "Waiting on Ana" even when the code host was never asked.

## Coding agents

Tasks go to Claude Code by default. Codex and Gemini ship with cockpit as well, and a plugin can add another CLI that works without a terminal and prints JSON lines:

```ts
k.agent({
  id: "aider",
  name: "Aider",
  bin: "aider",
  about: "Small edits in a few files.",
  models: () => [{ id: "sonnet", label: "Sonnet" }],
  // one turn; the prompt arrives on stdin
  headless: (t) => ["--json", ...(t.model ? ["--model", t.model] : []), ...(t.resume ? ["--restore", t.resume] : [])],
  // one line of output, as cockpit's events
  parse: (line, state) => {
    const d = JSON.parse(line);
    if (d.type === "start") return [{ kind: "session", id: d.id }];
    if (d.type === "reply") return [{ kind: "message", text: d.text }];
    if (d.type === "end") return [{ kind: "usage", input: d.tokens_in, output: d.tokens_out }, { kind: "done", ok: d.ok }];
    return [];
  },
  terminal: (resume) => (resume ? ["--restore", resume] : []),
});
```

- Each prompt runs `bin` with the arguments from `headless`, in the task's worktree, and writes the prompt to stdin. The first turn's `session` event gives the agent's own id for the conversation, and later turns get it back as `t.resume`.
- `parse` turns a line into events: `session`, `message`, `thinking`, `tool`, `tool_result`, `usage`, `done` and `error`. A line it throws on is skipped. `state` is kept for the whole turn, for an agent that splits one answer over several lines.
- `t.access` says what the agent may do: `sandbox` (edit its folder and run commands there), `readonly`, or `full`. `t.writable` lists the folders outside the worktree it also needs to write to, like the repo's git data, so it can commit.
- `terminal` gives the arguments that open the same conversation in the agent's own screen, for the **Open in** button.
- `bin` can be changed per machine in `config.local.toml`, under `[agents.<id>]`.

## Access from other machines

Cockpit answers direct requests from its own machine and nothing else. A request from another machine, or one through a proxy (it has `X-Forwarded-For`), gets in only when an access plugin says so:

```ts
k.access({
  name: "Tailscale",
  allow: (req) => req.local && !!req.header("x-forwarded-for") && req.header("tailscale-user-login") === k.setting("login"),
});
```

- `allow` runs on every request and every socket connection, so keep it quick and synchronous.
- Return `true` to let the request in. Anything else leaves it to the other access plugins, and if none says yes it gets a 401.
- `req.local` is true when the connection comes from this machine, which is where a proxy like `tailscale serve`, Caddy or nginx would be. Only trust identity headers from a local proxy: anyone can send a header from outside.
- Requests from another site's pages are refused before any plugin is asked.
- The bundled `tailscale` plugin is the example. For a reverse proxy with its own sign-in, check the header it sets, the same way.

## Runs

The Runs screen lists every test, lint, typecheck, audit, E2E, proof, verify and CI run, whatever started it. A run has a `kind` (`unit`, `lint`, `typecheck`, `audit`, `e2e`, `proof`, `verify`, `ci` or `other`), a `status` (`running`, `pass`, `fail` or `cancelled`), its output, and files such as a video. When a run has no kind, cockpit works one out from its command, using the patterns in Settings → Board and automation. Runs are linked to the ticket and worktree they belong to, and a run that fails sends a notification. Runs older than 90 days, or past the newest 3000, are removed, except those of a ticket in the current sprint.

| | |
|---|---|
| `k.runs.start({ name, kind, ticket, worktree, branch, cwd, command, meta })` | Starts a run and returns it. `branch` finds its worktree and ticket when there's no `cwd`. |
| `k.runs.event(id, event)` | Adds to a run while it goes. The event is the same one scripts send (see below). |
| `k.runs.record({ ..., status, exitCode, output, summary, endedAt, quiet })` | Records a run that's already over, in one call. The GitHub plugin uses this for each CI check of your open PRs. With `quiet: true` a failure sends no notification, which suits runs you copy in or catch up on later. |
| `k.runs.list({ ticket, worktree, kind, status, since, limit })`, `k.runs.get(id)` | Runs, newest first. |
| `k.runs.steps({ kinds, parse })` | Turns the raw step lines of these kinds of runs (or their output, when no steps were sent) into a list of steps for the run's page. `parse(lines)` returns `{ text, state, depth }[]`, where `state` is `running`, `ok`, `failed`, `skipped` or `section`. |
| `k.runs.onStart(fn)` | `fn(run, body)` returns extra fields for whoever started the run over `POST /api/runs`, for example where a script should save its video. |
| `k.runs.video(fn)` | Makes the video of a `cockpit run --record` run in a look of your own. `fn({ run, screen, output, seconds, out, progress })` gets the browser's window and the output pane as two mp4s of the same length, writes the finished mp4 to `out` and can call `progress(0..1)`. If it throws, cockpit makes its plain side-by-side video instead. |
| `k.runPanel({ kinds, page, steps })` | Shows `page` from your folder in a frame on a run's page, with `?run=<id>`. Leave out `kinds` to show it for every run. Set `steps: true` when your page shows the run's steps itself, and the run page leaves out its own list. |

Scripts use the HTTP API the same way:

- `POST /api/runs` with `{ name, kind, command, cwd, ticket }` starts a run. Fields it doesn't know go into the run's `meta`. The answer has the run's `id`, `link` (`/runs/<id>`) and `videoDir`, a folder for the run's files. With `finished: true` and `exitCode` (and optionally `output`), it records a run that's already over.
- `POST /api/runs/<id>/event` adds to it. The body can have `lines` (output lines), `steps` (raw step lines), `progress` (0 to 1), `phase`, `error`, `summary` (`{ passed, failed, skipped, failing }`), `artifacts` (`[{ path }]`, copied in from the run's folder or the temp folder), `meta`, and `result` (`{ status, file }`, where `status` is the exit code and `file` is a file the script saved in `videoDir`). A `phase` of `done`, `failed` or `cancelled` ends the run. Without a status, it passed if its exit code was 0.
- `GET /api/runs`, `GET /api/runs/<id>` (with the end of its output and its steps), `GET /api/runs/<id>/log`, `GET /api/runs/<id>/artifacts/<name>` (supports range requests, so videos can seek), `DELETE /api/runs/<id>` and `POST /api/runs/<id>/rerun`.
- A script that reports its own runs can send `rerun` in its first `POST /api/runs`, with the shell command that starts it again. Rerun then runs that command in a terminal and lets the script record the new run, so a recording script records and shows live just as it did the first time.

From a shell, `bin/cockpit run [--kind k] [--name n] [--ticket T] [--artifact <path>]... -- <command>` runs a command, streams its output into a run and exits with the command's exit code. If cockpit isn't running, the command still runs as normal. It suits skills and git hooks. Set `COCKPIT_URL` when cockpit isn't on `127.0.0.1:8770`. Add `--record` to make a video of it: the command runs on a virtual screen, its output shows beside it, and the video is kept with the run. This needs Linux with Xvfb, ffmpeg and Chromium.

### Run something

The Runs screen and ⌘K have a "Run something" picker. You pick a worktree or the main checkout, then something to run in it, and it starts as a run. Cockpit offers the verify command (`repo.verifyCommand`) and every `package.json` script up to four folders deep, run with the package manager that the nearest lockfile or `packageManager` field names. Plugins add their own options with `k.runOptions`:

```ts
k.runOptions({
  // wt is { path, name, branch, ticket, main }
  async list(wt) {
    return [{ id: "smoke", kind: "e2e", label: "Run the smoke flows", detail: "pnpm run e2e smoke/", group: "My plugin" }];
  },
  async start(id, wt) {
    const t = k.terminal({ cwd: wt.path, command: "pnpm", args: ["run", "e2e", "smoke/"], run: { kind: "e2e", name: "smoke flows", ticket: wt.ticket } });
    return { runId: t.runId, term: t.id };
  },
});
```

| | |
|---|---|
| `list(wt)` | Returns what you can run there, as `{ id, kind, label, detail, group }[]`. `id` only has to be unique among your own options. `group` is the heading it goes under, and your plugin's name is used when you leave it out. Return `[]` when nothing applies, for example when there is no open PR. Cockpit asks each time the picker opens and keeps the answer for 30 seconds. A list that throws or takes longer than 20 seconds is shown in the picker as an error, and the other options still appear. |
| `start(id, wt)` | Starts the option. It is only called with an id your `list` returned for that worktree. Return `runId` and the picker opens that run, or `term` and it opens that terminal. If neither is ready yet, return a `note` to show, with an optional `link` to a cockpit page where the user can follow it. Throw an `Error` with `status: 400` to show a message instead. |

The HTTP API is `GET /api/runs/options?worktree=<path>` (add `force=1` to skip the 30 seconds) and `POST /api/runs/options/start` with `{ worktree, id }`. Both refuse a path that isn't one of cockpit's worktrees, and start refuses an id that isn't in that worktree's list. Plugin ids come back as `plugin:<plugin id>:<your id>`. Scripts open in a terminal beside the worktree's Claude terminal, and verify runs the way it does from the Board.

## Sidebar badges

Each sidebar entry can show a badge next to its name. A pulsing dot means something is running, an amber number means something needs you, a red number counts failures, and a grey number is a plain total. Cockpit sets the badges for its own screens. A plugin sets the badge for its screens with `k.badge(screenId, badge)`:

```ts
k.badge("main", { live: 1, failed: 2, title: "1 flow running · 2 tickets failing" });
k.badge("main", null); // clears it
```

A badge has `live`, `attention`, `failed` and `count`, all optional counts, and a `title` that says what they mean. The title is shown in the tooltip and read out by screen readers. A count of 0 is left out, and a badge with nothing left clears itself. The most urgent part is shown: failed or attention over live, and live over count. With `untilSeen: true`, the badge goes away the next time the screen is opened, which suits news like "3 new results".

Badges are kept in memory. They're dropped when the plugin turns off or reloads, so set yours again in `setup`. Change it when something happens, from `k.on` or a timer you already have, and keep the work cheap: don't call an outside service just to update a badge. Badges only show for screens that are in the sidebar.

## Screens

A screen is a page from your folder, shown in a frame on the same origin as cockpit. Write it however you like: plain HTML, or a Vite or React build placed in `assets/`. Load the SDK to fit in:

```html
<link rel="stylesheet" href="/plugin-sdk.css" />
<script src="/plugin-sdk.js"></script>
```

`plugin-sdk.css` gives you the app's base styles: `.card`, `.row`, `.muted`, `.faint`, `.error`, and buttons with `.primary`. `plugin-sdk.js` copies the current theme's CSS variables (`--ground`, `--panel`, `--ink`, `--muted`, `--line`, `--cobalt` and the rest) onto your page and keeps them updated. It also gives you `window.cockpit`:

| | |
|---|---|
| `cockpit.api(path, init)` | Calls your own routes. `body` can be an object. |
| `cockpit.core(path, init)` | Calls cockpit's own API, e.g. `cockpit.core("/sessions?limit=5")`. |
| `cockpit.navigate(to)` | Moves the app to another screen. |
| `cockpit.copy(text)` | Copies to the clipboard. |
| `cockpit.openTerminal({ cwd, title })`, `cockpit.launchClaude({ cwd, prompt })` | Starts a terminal or Claude, and goes to it. |
| `cockpit.onTheme(fn)` | Runs `fn(theme)` now and again on every theme change, for canvases and charts. |
| `cockpit.terminalUrl(id)` | The address of a bare terminal, to put in an `<iframe>`. When that terminal's process ends, your page gets a `cockpit:terminal-exit` message. |
| `cockpit.typeInto(id, text)` | Types into a terminal and presses Enter. Several lines go in as one paste. |
| `cockpit.openSession(id)` | Opens a Claude session in a terminal, resuming it if needed. |

### Errors, loading and tabs

A few helpers keep plugin screens consistent with each other. Use them rather than writing your own:

| | |
|---|---|
| `cockpit.esc(text)` | Escapes text so it's safe to put in `innerHTML`. |
| `cockpit.fail(el, err)` | Replaces what `el` holds with the error in a red `.error` box. `el` is an element or a selector. |
| `cockpit.loading(el, text)` | Puts a loading line in `el` until you draw into it. `text` defaults to "Loading…". |
| `cockpit.refreshButton(btn, fn)` | Runs `fn` when the button is clicked. The button is disabled while `fn` runs, and if it throws, the error shows next to the button until the next try. Returns the run, so you can call it yourself with the same handling. |

For tabs, use `<nav class="tabbar">` with a `<button>` per tab, and mark the selected one with `class="on"` or `aria-selected="true"`.

When a call fails, say so on the screen. Catch an error silently with `.catch(() => [])` only when the data really is optional, and add a comment saying why.

Your page also works opened directly, outside cockpit, with the default colours. `server.ts` and `plugin.json` are never served. Everything else in the folder is, to anyone signed in to cockpit.

## Skills

If a plugin's flow needs Claude to work a certain way, ship a skill with it, or point at one people write themselves:

```json
"skills": [
  { "name": "cockpit-pr-review" },
  { "name": "my-own-skill", "required": true }
]
```

- A skill with a folder in your `skills/` ships with the plugin. Settings → Setup shows whether it's installed, and installs or updates it in `~/.claude/skills` with one click. If someone edited their copy, it's backed up first.
- A skill without a folder is only checked for, for one that lives with the person, not the plugin.
- `required` puts a missing skill on the setup banner on Today. Any skill a configured prompt calls by name, like `/cockpit-pr-review` in the review prompt, counts as required too.
- Give shipped skills a name of their own, ideally prefixed with your plugin's, so they don't clash with someone's own skills.
- Cockpit ships `cockpit-plugins`, a skill for writing plugins with this guide as its reference. The GitHub plugin ships `cockpit-pr-review`, and the Jira plugin ships `cockpit-ticket`.

## Themes

Each file in `themes/` is one theme:

```json
{
  "id": "my-dark",
  "name": "My Dark",
  "scheme": "dark",
  "ui": { "ground": "#151a22", "panel": "#1c222c", "raised": "#232a35", "ink": "#dce2ea", "muted": "#8c96a6", "faint": "#6f7989", "line": "#2c3441", "accent": "#6f93f5", "amber": "#e0a93a", "green": "#5cbf86", "red": "#e8706a" },
  "ansi": ["16 terminal colours, normal then bright"]
}
```

Colours are `#rrggbb`, and `ansi` has exactly 16 of them. The id gets your plugin id in front, so two plugins can't clash. Your themes show up in the theme picker, ⌘K and the Auto choices, and they colour the terminal, the editor and the charts. If the plugin is turned off while one of its themes is in use, cockpit goes back to its default theme. For text that stays readable, aim for `ink` and `muted` at 4.5:1 against `panel`, and the rest at 3:1. The bundled themes are tested to that in `server/test/plugins.test.ts`.

## Security

A plugin with code runs inside the cockpit server, as your user, with the same access to your files, your logins and your Claude sessions. Only install plugins you trust. Screens run on cockpit's origin, so they can call its whole API.

## Examples

- `plugins/example`: a screen, two routes, a setting and a listener. It's off by default.
- `plugins/themes-extra`: two themes and no code.
- `plugins/jira`: a tracker, through Atlassian's `acli`.
- `plugins/push`: listens to `notify` and posts to ntfy or Pushover, with secret settings and a test route.
- `plugins/github`: a code host, through `gh`, with a token setting passed as `GH_TOKEN`.
- `plugins/meetings`: a screen that records audio in pieces, a long-running helper process, a route that returns a `Response` (the recording, with ranges for seeking) and `claude -p` run as a job.
