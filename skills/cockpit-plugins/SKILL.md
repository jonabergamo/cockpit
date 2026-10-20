---
name: cockpit-plugins
description: Write or change a cockpit plugin, adding screens, themes, API routes, a work tracker (Linear, GitLab issues...) or a code host to the cockpit dashboard. Use when asked to make a cockpit plugin, theme or integration, or to fix one.
---

# Writing a cockpit plugin

The full guide is in `references/PLUGINS.md`. Read it before you start. The short version:

- A plugin is a folder named after its id, holding a `plugin.json`, plus optionally `server.ts`, `themes/*.json`, `assets/` and `skills/`.
- Your own plugins go in the folder shown in cockpit's Settings → Plugins. Saving a file reloads the plugin.
- `server.ts` exports `default function setup(k)`. `k` registers routes, screens, themes, listeners and providers. Types are in `@cockpit/shared` (`shared/src/plugin.ts` in the cockpit repo).
- Screens are HTML pages in `assets/` that load `/plugin-sdk.js` and `/plugin-sdk.css`, so they follow the app's theme and can call `cockpit.api(...)`.
- A theme plugin needs no code: one JSON file per theme in `themes/`, with 11 `ui` colours and 16 `ansi` colours.
- A tracker plugin calls `k.tracker({...})`, and a code host `k.codeHost({...})`. The bundled `jira` and `github` plugins are the examples to copy.

When you're done, check that the plugin shows as on and without errors in Settings → Plugins, and look at its log there.
