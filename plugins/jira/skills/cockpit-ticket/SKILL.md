---
name: cockpit-ticket
description: Take a Jira ticket from its link or key to a pull request, working in the current folder (usually the worktree cockpit made for it). Use when given a Jira ticket link or key to work on, including from cockpit's Start Claude buttons.
---

# Work a Jira ticket through to a pull request

You get a Jira link or a key like `ABC-123`. You're usually started in the worktree cockpit created for that ticket, already on its branch.

## 1. Read the ticket

```sh
acli jira workitem view <KEY> --fields summary,description,status,issuetype,parent,comment --json
```

Read the description, the acceptance criteria and the comments. If the ticket is unclear about what done looks like, ask before writing code.

## 2. Check where you are

```sh
git status
git branch --show-current
```

- If you're on a branch with the key in its name, work there.
- If you're on the main branch, make one: `git switch -c feat/<KEY>/<short-slug>`.
- Never commit to the main branch.

## 3. Make the change

- Keep it to what the ticket asks for.
- Follow the code around you: its naming, its patterns, how much it comments.
- Run the project's own checks before you call it done: its lint, type check and the tests that cover what you touched. The repo's README, package scripts or Makefile show how.

## 4. Commit and open the PR

Ask before committing, and show what's going in.

```sh
git add <files>
git commit -m "<KEY>: <what changed>"
git push -u origin HEAD
gh pr create --title "<KEY>: <summary>" --body "<what and why, and how it was tested>"
```

If `gh` isn't installed or logged in, push the branch and give the person the compare link instead. Put the key in the PR title so cockpit links the PR to the ticket.

## 5. Move the ticket, if asked

```sh
acli jira workitem transition --key <KEY> --status "<status>"
```

Only do this when the person asks, since teams use their statuses differently.
