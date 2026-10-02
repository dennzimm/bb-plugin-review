---
name: branch-review
description: Review someone's branch, GitLab merge request, or GitHub pull request without implementing anything, using the Review plugin's read-only worktree threads; also post, re-review, and track review findings.
---

# Reviewing branches and merge requests

Use this when the user asks to review a branch, merge request, or pull request, to review changes without modifying code, or to post, re-review, or check the status of a review.

## Start a review thread (preferred for someone else's change)

```bash
bb review start <source> --project <id-or-name> [--into <target>] [--depth quick|standard|deep] [--focus "<text>"] [--post]
```

- `<source>`: branch (`feature/x`, `origin/feature/x`), GitLab `!123` or URL, GitHub `#123` or URL, or a bare number. Quote `!123` in shells.
- The plugin fetches the change on the project's machine, opens a new worktree at the head commit, sets the diff panel's merge base, analyses size, risk, dependencies, and path rules, looks up the linked ticket, and starts a read-only review thread.
- `--depth`: `quick` reports only high-confidence blockers; `deep` adds parallel passes and, when configured, checks, a UI preview, and a second reviewer.
- `--post` lets the reviewer save its findings as a draft review. Only pass it when the user asked for that.
- `--project` defaults to the current thread's project; the personal workspace is not a project, so name it there.

Report the started thread as `@thread:<id>` and do not wait for it unless the user asks.

## Work with a review

Run these inside the review thread, or pass its thread id:

- `bb review findings [thread]`: findings with ids (F1, F2, …) and status.
- `bb review post [thread] [--findings F1,F3] [--publish]`: save open findings as a GitLab draft review (or GitHub pending review) for the user to publish. Use `--publish` only when the user explicitly asks to publish.
- `bb review publish [thread]`: publish the draft review.
- `bb review again [thread]`: re-review after new commits. It moves the worktree to the new head and asks the reviewer to check earlier findings and the new commits.
- `bb review dismiss <F2> [thread] --reason "…" [--remember]`: dismiss a finding; `--remember` makes future reviews of the project avoid similar findings.
- `bb review sync [thread]`: refresh comment status (resolved, deleted drafts), merge request state, and new commits.

## Overview commands

- `bb review queue [--refresh]`: merge requests waiting for the user's review.
- `bb review list [--project …] [--archived]`: review threads with verdict and counts.
- `bb review stats`: how many findings were posted, fixed or resolved, and dismissed.
- `bb review learnings list|add|remove`: what reviews are told not to report.

## Review inside the current thread

When the user wants a review of the current workspace or a diff in this thread, run `bb review guidelines` and follow the method it prints. Do not modify code unless the user asks.

In any composer, typing `!` lists open merge requests of the project; picking one attaches its details.
