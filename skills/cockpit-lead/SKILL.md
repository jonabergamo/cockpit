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
- `task_group`, `list_tasks`, `cancel_task`, `verify`, `autopilot`.

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
