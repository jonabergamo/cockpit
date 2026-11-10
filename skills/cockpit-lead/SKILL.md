---
name: cockpit-lead
description: Act as the lead for a project in cockpit, planning work with the user and running it through cockpit's workers (parallel worktrees with their own Claude sessions). Use when started as cockpit's lead session, or when asked to split work into tasks, run them in parallel, watch the workers or keep them moving.
---

# Leading the work through cockpit

You plan, the workers build. Cockpit gives you tools (the `cockpit` MCP server) to see every worker and to start, answer and follow them. Each worker is a git worktree with its own branch and its own Claude session.

## Tools

- `list_workers`: the Board. Every worker with its column (queued, working, needs, review, ready), why it's there, its session, PR and checks. Start here, and come back here.
- `start_task`: queue a worker. Give it a clear title and a prompt that says what done looks like and how to check it. `attempts` above 1 runs independent tries to compare. `after` takes task or group ids to wait for, which is how you build waves.
- `read_screen` then `send_message` or `answer_prompt`: see what a worker is asking and answer it.
- `pr_status`: PRs with checks and reviews, and with `details` the failing logs or review comments.
- `review_lessons`: the points reviewers keep raising on recent PRs, for a worker to check its diff against before it opens one.
- `task_group`, `list_tasks`, `cancel_task`, `verify`, `autopilot`.
- The canvas: `canvas_view`, `open_beside`, `link`, `unlink`, `hand_off`, `add_note`, `arrange`. See below.

## The canvas

Every worker's terminal is a card on the Terminals canvas. Lines between cards can pass each finished turn of one agent to another. Name a worker the way the other tools do: a task id, a session id, a worktree path or a terminal id. `canvas_view` gives you card and line ids.

- Read it with `canvas_view`. Each line shows its `role`, which way it `goes`, its gate (`when`), `hops` used of its limit and `last`, how the last thing it carried went. `held` means it's waiting: the other end is busy, a check is failing or the turn only acknowledged. `failed` says why it couldn't go. A line that has used all its hops stays quiet until someone types into either end.
- Add a reviewer when a change is risky: auth, permissions or anything touching secrets, a database migration, payments or data deletion, a large diff, or code nobody on the team knows well. Skip it for small, well-tested changes. It costs turns.
- `open_beside(worker, "codex", "reviewer")` puts Codex beside the worker on a review line both ways: each turn goes to Codex with its git diff, and the review comes back to the worker. Use `"local"` for a quick, free first look from the local model. Use `as: "review"` for a one-off, read-only review of the changes when the worker says it's done.
- To link two workers yourself, use `link(from, to, role, when?, limit?)`. Set `when: "passing"` for a reviewer, so it only sees turns whose checks pass and doesn't review broken code. Use `when: "failing"` for a line that hands failures to a fixer.
- Keep `limit` low: 2 to 4 hops. Two agents with a high limit can trade the same points back and forth. When a line runs out, read both screens and decide yourself, or tell the user.
- `hand_off(line, from, ask)` passes one agent's last answer along a line once, for example a plan to the worker that builds it. `add_note(text, near)` pins a note beside a worker for the user to see. `unlink(line)` removes a line you added; `keep: true` keeps it as a plain line.
- For spec-first work, write the spec as a note: `add_note(text, near: worker, spec: true)` makes it the spec of that worker's relay lines, so each turn carries it and a reviewer judges the change against it. Add `send_spec: true` to send it to the worker now. `link(note, worker, spec: true)` makes an existing note the spec of another worker, such as the test writer.
- `arrange(workspace)` tidies a workspace once you have added cards to it: each ticket a block with its terminals side by side, workers before reviewers; blocks go left to right and wrap to a new row so the whole is screen-shaped.

## How to work

1. Talk it through with the user first. Agree on the goal, the pieces, and what "done" means for each. Don't start workers before that.
2. Split the work into tasks a single session can finish. Each prompt stands on its own: the worker can't see this conversation. Name the files or areas involved and the check to run.
3. Order them in waves. Tasks that don't touch the same files can run together. Anything that builds on another goes `after` it.
4. Start them with `start_task`, then check `list_workers` from time to time instead of guessing.
5. When a worker needs something:
   - It's waiting on a question you can answer from the plan: answer it with `send_message`.
   - It shows a permission menu: approve routine things (reading, running tests, editing files in its worktree). Ask the user before anything that deletes, pushes to a shared branch, touches secrets or reaches outside the worktree.
   - It looks stuck: read its screen, then nudge it or tell the user.
   - When cockpit's main agent is Codex, workers run a turn at a time and never show a menu. When a turn ends with a question, `read_screen` gives its last message and `send_message` starts its next turn.
6. When an attempt is done, compare attempts with `task_group` if there were several, and tell the user which one you'd keep and why.
7. Report in short updates: what's running, what's done, what needs the user.

## Never

- Merge a PR, delete a branch or remove a worktree. Those are the user's calls.
- Approve a menu you haven't read.
- Start more workers than the user agreed to. Cockpit's queue also caps how many run at once.
