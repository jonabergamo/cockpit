---
name: cockpit-ideas
description: Save ideas and future projects to cockpit's Ideas screen, or read what's already there. Use when asked to "save this idea", "add it to my ideas", "park this for later", "add these next steps to my ideas", or to list or update ideas for a project.
---

# Cockpit ideas

Cockpit's Ideas plugin keeps ideas for later, grouped by project. It answers on cockpit's local address, `http://127.0.0.1:8770` unless the person's cockpit runs elsewhere. Calls from the same machine need no login.

## Save one idea

```sh
curl -s -X POST http://127.0.0.1:8770/api/plugins/ideas/x/ideas \
  -H 'content-type: application/json' \
  -d '{"project": "cockpit", "title": "Meeting action items to tickets", "notes": "Markdown with the why, what we have, open questions", "tags": ["meetings"]}'
```

- `title` is required. Keep it short and concrete, like a ticket summary.
- `project` is a project's name. A new name makes the project.
- `notes` is Markdown. Put the reasoning there: the problem, the idea, what already exists, how to tell it worked, open questions. Write it so it still makes sense in six months.
- Optional: `status` (one of the screen's statuses, `Inbox` by default), `group`, `phase`, `estimate`, `tags`, `ref` (a number in a list or a ticket key), `source` (a link to where it came from).

## Save several at once

`POST /api/plugins/ideas/x/import` with `{"project": "name", "ideas": [{...}, ...]}`. An idea with the same title in the same project is updated instead of doubled, so importing a list again is safe.

## Read what's there

`GET /api/plugins/ideas/x/data` returns `{projects, ideas, statuses}`. Check it before adding, so you don't save the same idea twice under another title.

## Change one

`PUT /api/plugins/ideas/x/ideas/<id>` with only the fields to change, like `{"status": "Doing"}`.

## How to work

- When the person shares ideas or next steps in a conversation, offer to save them, one idea per item. Don't save without being asked.
- After saving, say how many went into which project, and that they're on the Ideas screen.
