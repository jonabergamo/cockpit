# Writing a cockpit plugin

A plugin is a folder with a `plugin.json`. It can add screens, themes, API routes, listeners and Claude Code skills, and it can plug in a work tracker, a code host or a way in from other machines. This guide is for people and for AI assistants writing one.

## Where plugins live

- `plugins/` in this repo holds the bundled ones. They start on unless their manifest says `"defaultOn": false`.
- Your own go in the plugins folder. That's `pluginsDir` in `config.local.toml`, or `data/plugins` if you leave it unset. They start off until you turn them on in Settings → Plugins.
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
  k.on("session.idle", (s) => k.log("a session is waiting", s));
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
| `k.route(method, path, handler)` | Serves `/api/plugins/<id>/x<path>`. `:name` parts end up in `params`. The handler gets `{ query, body, params }` and returns JSON-able data. To send a 400, throw an `Error` with `status: 400`. |
| `k.screen({ id, title, page })` | Adds a screen to the sidebar and ⌘K, at `/p/<id>/<screen>`. `page` is a file in your folder. |
| `k.theme(theme)` | Adds a theme from code, for themes you generate. Static ones go in `themes/`. |
| `k.on(event, fn)` | `session.started`, `session.idle`, `session.ended`, `worktree.created`, `worktree.removed`, `terminal.opened`, `notify`. |
| `k.run(cmd, args, { cwd, input })` | Runs a command and resolves with its output, with your `env` settings set. |
| `k.terminal({ cwd, title, command, args })` | Opens a cockpit terminal. |
| `k.claude({ cwd, prompt, title })` | Starts Claude in a terminal. |
| `k.notify({ title, body, link })` | Shows a cockpit notification. |
| `k.sessions({ liveOnly, limit })`, `k.terminals()` | The Claude sessions and terminals cockpit knows about. |
| `k.cache(key, maxAge, fn, force)` | Runs `fn` and keeps its result for `maxAge` ms in cockpit's cache. `force` runs it again. |
| `k.ticketOf(...strings)` | Finds a ticket key in branch names or titles, using the active tracker's pattern. |
| `k.tracker(provider)`, `k.codeHost(provider)` | Plugs a work tracker or a code host into cockpit. See below. |
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
- A code host needs `myPrs`. Add `reviewQueue`, `failingChecks`, `parsePr`, `prInfo`, `pendingReview` and `deletePending` for PR reviews and for fixing failed checks with Claude.
- The shapes are in `shared/src/plugin.ts` (`Tracker`, `CodeHost`). Tickets and PRs use the same `Ticket` and `PullRequest` types the screens already read.
- Only one of each is in use at a time. If two plugins offer one, Settings lets you pick. With none, the screens that need it leave the sidebar.

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
- `plugins/github`: a code host, through `gh`, with a token setting passed as `GH_TOKEN`.
