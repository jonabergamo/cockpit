# Contributing to cockpit

Thanks for helping out. Bug reports, fixes, plugins and themes are all welcome.

## Before you start

- For a bug, open an issue with the steps to reproduce it, unless the fix is small and obvious.
- For a new feature, open an issue first so we can agree on the shape before you build it.
- If it's an integration with one particular tool, like a tracker, a code host or a chat app, it probably belongs in a plugin rather than in core. See [plugins/PLUGINS.md](plugins/PLUGINS.md). Core is what any Claude Code user needs: sessions, terminals, worktrees, code and usage.

## Setting up

You need Node 22, pnpm, git, tmux and Claude Code.

```sh
pnpm install
cp config.example.toml config.local.toml
pnpm dev            # UI on http://127.0.0.1:8771, API on 8770
```

To work without touching your real Claude data, run in demo mode against the example config:

```sh
COCKPIT_DEMO=1 COCKPIT_CONFIG=config.example.toml pnpm dev
```

## The layout

| Folder | What's in it |
| --- | --- |
| `server/` | Hono on Node. Reads `~/.claude`, runs terminals in tmux, loads plugins, keeps an index in SQLite. |
| `web/` | React, TanStack Router and Query, Tailwind, xterm.js and Monaco. |
| `shared/` | Types used by both, including the plugin API in `shared/src/plugin.ts`. |
| `plugins/` | Bundled plugins: Jira, GitHub, Tailscale, extra themes and an example. |
| `skills/` | Claude Code skills that ship with cockpit. |
| `desktop/` | The small Electron wrapper for the menu bar. |

## Before you open a pull request

```sh
pnpm build
pnpm test
pnpm smoke     # opens every page in a headless browser, in demo mode
```

- Keep changes focused. One pull request per fix or feature.
- Match the style around you. The code has few comments, and the ones it has say why, not what.
- Don't commit anything personal or from your own setup: no real ticket keys, names, hostnames, tokens or screenshots of your data. Use demo mode for screenshots.
- For UI changes, add a before and after screenshot to the pull request.

## Plugins and themes

You don't need a pull request to share a plugin. It's a folder people can drop into their plugins folder. If you think it should ship with cockpit, open an issue first.

Themes are JSON files with no code, so they're the easiest place to start. Add one to `plugins/themes-extra/themes/`, and the tests check that its colours have enough contrast.

## Licence

By contributing you agree that your work is released under the [MIT licence](LICENSE).
