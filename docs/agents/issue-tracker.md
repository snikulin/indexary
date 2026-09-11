# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create an issue with `gh issue create`.
- Read an issue and its discussion with `gh issue view <number> --comments`.
- List and filter issues with `gh issue list`.
- Comment with `gh issue comment <number>`.
- Apply or remove labels with `gh issue edit`.
- Close an issue with `gh issue close`.

Infer the repository from the current checkout and its `origin` remote.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. Resolve an
ambiguous reference by trying `gh pr view <number>` and then
`gh issue view <number>`.

## Skill operations

When a skill says “publish to the issue tracker”, create a GitHub issue.

When a skill says “fetch the relevant ticket”, read the complete issue body,
labels, and comments.

Publish tickets in dependency order. Represent blocking relationships using
GitHub native issue dependencies when available. Otherwise, add a
`Blocked by: #<number>` line to the issue body.

A ticket is ready for work when all its blockers are closed and it has no
assignee.
