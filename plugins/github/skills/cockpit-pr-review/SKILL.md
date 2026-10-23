---
name: cockpit-pr-review
description: Review a GitHub pull request and leave the findings as a pending (draft) review with inline comments, never submitted. Use when given a PR link or number to review, including from cockpit's PR reviews screen, which reads the review link and verdict this skill prints at the end.
---

# Review a pull request as a pending review

You get a PR link (`https://github.com/<owner>/<repo>/pull/<n>`) or a number. Review it and leave your comments as a **pending** review. The person submits it themselves on GitHub. Never submit, approve or request changes through the API.

## 1. Read the PR

```sh
gh pr view <n> -R <owner>/<repo> --json title,body,author,baseRefName,headRefName,headRefOid,files,additions,deletions
gh pr diff <n> -R <owner>/<repo>
```

If you're in a checkout of the repo, read the surrounding code too, not only the diff. Check out the PR's branch read-only if you need to run something (`gh pr checkout <n>`), and leave the working tree as you found it.

## 2. Decide what's worth a comment

Comment on things that matter: bugs, wrong behaviour, missing error handling, security problems, race conditions, broken edge cases, missing tests for risky logic, and code that's hard to follow. Skip style nits that a formatter or linter would catch. Every comment should say what's wrong and why, and suggest a fix when there's a clear one. Keep each one short.

Review the whole PR unless the prompt narrows it down, for example to the frontend only.

## 3. Leave them as a pending review

Check for a pending review of your own first:

```sh
gh api repos/<owner>/<repo>/pulls/<n>/reviews --jq '.[] | select(.state=="PENDING") | {id, node_id, user: .user.login}'
```

- **No pending review:** create one with all the comments at once. Leaving out `event` keeps it pending.

  ```sh
  gh api repos/<owner>/<repo>/pulls/<n>/reviews --method POST --input - <<'JSON'
  {
    "commit_id": "<headRefOid>",
    "comments": [
      { "path": "src/app.ts", "line": 42, "side": "RIGHT", "body": "..." }
    ]
  }
  JSON
  ```

- **There is one, and the prompt says to add to it:** add each comment to it as a thread.

  ```sh
  gh api graphql -f query='mutation($r:ID!,$p:String!,$l:Int!,$b:String!){addPullRequestReviewThread(input:{pullRequestReviewId:$r,path:$p,line:$l,side:RIGHT,body:$b}){thread{id}}}' -f r=<node_id> -f p=src/app.ts -F l=42 -f b='...'
  ```

- **There is one and the prompt says nothing about it:** stop and ask whether to add to it or replace it.

Lines must be lines the diff touches, on the side you're commenting on. If a comment can't attach to a line, put it in the review summary instead.

## 4. Finish with these two lines

Cockpit reads them, so print them exactly like this as the last thing you write:

```
Pending review: https://github.com/<owner>/<repo>/pull/<n>#pullrequestreview-<review id>
<verdict>
```

`<verdict>` is one of:
- `Approved`: nothing worth flagging.
- `Approved with comments`: small things, nothing blocking.
- `Changes requested`: something should be fixed before merging.

Put the verdict on its own line, with a short reason after it if you like (`Approved with comments, two small things in the hook.`).

## A second look

When the prompt says it's a second look, it names the commit you reviewed and lists your earlier comments. Then:

- Review only the diff between that commit and the PR's head (`git fetch` first, then `git diff <old>..<new>`, or `gh api repos/<owner>/<repo>/compare/<old>...<new>`). Read the code around it as usual.
- Go through the earlier comments one by one and say whether each was fixed, answered or is still open. Put that list in the review summary.
- Only comment again where something is still open or the new changes brought a new problem. Don't repeat comments that were dealt with.
- If the prompt says the branch was rewritten, the old commit may be gone. Review the whole diff, but focus on the parts your earlier comments were about, and say so in the summary.

The two lines at the end are the same.
