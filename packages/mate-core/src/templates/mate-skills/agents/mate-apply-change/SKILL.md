---
name: mate-apply-change
description: Implement a change on a recorded delivery branch, offering the Workset's Delivery Branch (default workset/<workset-id>) instead of a protected branch. Builds on the OpenSpec apply workflow. Use when the user wants to implement, apply, or continue implementing a reviewed change.
allowed-tools: Bash(mate:*), Bash(openspec:*), Bash(git:*)
license: MIT
compatibility: Requires the mate CLI and the openspec capability enabled.
metadata:
  author: mate
  version: "1.0"
---

# Mate Apply Change

The Apply change stage of the Delivery Path. Before any code changes, it records the
Working Repository branch the change is delivered through, so archive and publication
later know which merge to wait for. Then it runs the OpenSpec apply workflow.

## Step 1: Read the branch and the record

In the Working Repository, read local Git state only:

```bash
git symbolic-ref --quiet --short HEAD          # current branch; fails when detached
git symbolic-ref --quiet --short refs/remotes/origin/HEAD   # repository's default branch
```

The repository's default branch (`origin/HEAD`, e.g. `main`) is not the link result's
`defaultBranch`, which is the change's resolved delivery branch (e.g. `workset/<id>` under the default branch template).

Read the change's existing record without changing it:

```bash
mate artifact link "<change-name>" --json
```

**Umbrella Repository.** When the Working Repository has no `.git` of its own and its
direct child folders are Git checkouts, it is an Umbrella Repository: settle the branch
per scoped child, then continue at Step 3. A scoped child is a child whose
`git -C <child> config --get remote.origin.url` names one of the change's scoped
repositories. Read each scoped child's branch with
`git -C <child> symbolic-ref --quiet --short HEAD`, and its record with
`mate artifact link "<change-name>" --repository "<org/repo>" --json`, whose recorded
branch and `defaultBranch` are that child's.

- **Every scoped child is on the recorded branch or `defaultBranch`** → ask nothing;
  record it per child:
  `mate artifact link "<change-name>" --repository "<org/repo>" --branch "<branch>" --json`.
- **Otherwise** → name each child's branch and its unpushed commits, then offer one menu
  for all of them, with the same protected-branch and ticket rules as Step 2:
  1. **Create a worktree** (recommended): run
     `mate working worktree --change "<change-name>" --enter --json`. It records every
     child's branch and returns `enter.action` `handoff` with the mirrored worktree in
     `enter.path`. Report `enter.reason`, write no code, and stop; `## Next steps`: open a
     new session in `enter.path` and run `/mate-apply-change <change-name>` there.
  2. **Switch each child to `defaultBranch`** with `git -C <child>`, as Step 2's option 1
     does, recording each with `--repository "<org/repo>"`.

## Step 2: Settle the delivery branch

Read `defaultBranch`, `inheritedFrom`, `diagnostics`, `ticketFormat`, and
`ticketCandidate` from the link result. `defaultBranch` is the change's resolved
delivery branch, never the repository's default branch. Report every diagnostic;
never derive a default from a change or Workset name. `defaultBranch: null` means ask
for a branch name, not infer one. When `inheritedFrom` is not empty, `defaultBranch` is
the open branch of those `dependsOn` changes: say this change continues on it.
Preserve recorded branches after membership changes;
a mismatch is informational, and relinking requires explicit user confirmation.

A branch is **protected** when it is the repository's default branch or matches a configured
protected pattern; `mate artifact link` refuses a
protected branch unless it is recorded as a direct delivery. Mate never asks the forge,
so a branch only the forge protects looks unprotected; hence the menu below.

- **A branch is already recorded** and it is the current branch → continue. When the
  current branch differs and `git worktree list --porcelain` shows the recorded branch
  checked out in a linked worktree, run
  `mate working worktree --change "<change-name>" --enter --json`, which reuses it, and
  follow `enter` as in option 2 below. Otherwise, when the current branch differs, warn,
  name both branches, and ask before implementing whether to switch to the recorded
  branch or record the current one.
- **On `defaultBranch`** → record it without asking:
  `mate artifact link "<change-name>" --branch "<defaultBranch>" --json`.
- **Detached HEAD** → ask for the branch name, then record it.
- **On a fresh ticket branch** (only with `ticketFormat` `jira`): nothing is recorded,
  the current branch is not protected, `ticketCandidate` is set, and
  `git rev-list --count origin/HEAD..HEAD` is `0` → record it without asking
  (`mate artifact link "<change-name>" --branch "<current>" --json`) and say in one line
  that the change uses it with ticket `<ticketCandidate>`.
- **On any other branch**, protected or not → do not implement there yet. First name
  every local commit that is not on the remote (`git log --oneline HEAD --not --remotes`)
  and leave them where they are; never move, reset, or rebase them. On another
  Workset's Delivery Branch, name that Workset. Then offer one menu; option 1 is
  recommended, except option 3 when the current branch is not protected and
  `ticketCandidate` is set:
  1. **Create or switch to `defaultBranch`**: check local and `origin`
     refs; `git switch "<defaultBranch>"` when local,
     `git switch --track -c "<defaultBranch>" "origin/<defaultBranch>"` when remote-only.
     Otherwise the branch is new: record it first with
     `mate artifact link "<change-name>" --ticket "<KEY>" --json` when a ticket was given
     (below), else with `--branch "<defaultBranch>"`, then `git switch -c` the branch its
     record now names. Uncommitted edits carry over. Record an existing branch after
     switching. When `defaultBranch` is null, ask for a name instead; do not offer an
     inferred branch.
  2. **Create a worktree** (only when `defaultBranch` is set): say uncommitted edits stay
     in this checkout, run `mate working worktree --change "<change-name>" --enter --json`,
     adding `--ticket "<KEY>"` when a ticket was given (below);
     it records the branch. When `enter.action` is `tool`, say an approval prompt may
     follow (Claude Code asks), call the tool `enter.tool` with `enter.path`, then say
     `enter.path` is now the Working Repository and continue at Step 3 there. On `handoff`
     or a declined move, report `enter.reason` and any warnings, write no code, and
     stop. `## Next steps`: name each `repositories[].path`, open a new session in this
     repository's worktree, run `/mate-apply-change <change-name>` there. On failure,
     report its diagnostics and offer the other options again.
  3. **Use the current branch** (only when it is not protected): record it.
  4. **Use or create another branch**: the user names it. Record it first with
     `mate artifact link "<change-name>" --branch "<name>" --json`; only after that
     succeeds, check local and `origin` refs: `git switch "<name>"` when local,
     `git switch --track -c "<name>" "origin/<name>"` when remote-only, otherwise
     `git switch -c "<name>"` from the current `HEAD`, so a refused name leaves no branch.
     Uncommitted edits carry over. With `jira`, the menu hints to put the key in the name
     (`feature/ABC-123-acme-retry`); a named branch carries its ticket only in its name,
     so never pass `--ticket` for it. When the name holds no Jira key, say in one line
     that no ticket is tracked, and continue.
  5. **Work directly here** (protected branch only) — only when the user explicitly chooses it.
     Record it as a direct delivery:
     `mate artifact link "<change-name>" --branch "<branch>" --direct --json`.

**Tickets** exist only when `ticketFormat` is `jira`; otherwise never ask for, offer, or
mention one. A ticket only names a new branch; it is stored nowhere else. With `jira`,
when nothing is recorded or inherited and `defaultBranch` exists neither locally nor on
`origin`, options 1 and 2 accept an optional Jira key in the same answer: say so in the
menu (`1 ABC-123` names the new branch after the ticket; `1` alone creates it without
one). Option 4 takes no key in the answer; its name carries it. Never ask a separate
ticket question. An agent without a person to ask passes no
ticket. On a refused key, name the expected format and ask once more.

Record the branch before writing any code. When `mate artifact link` refuses, report
its message and ask; never work around it.

When its result lists `warnings`, a `dependsOn` change is not implemented yet, so this
change would be built without the code it builds on. Report each warning and ask
whether to apply the dependency first or continue here. A dependency that is
implemented but unarchived is no such warning; it only affects archive order.

## Step 3: Apply

Read [references/openspec-apply-change.md](references/openspec-apply-change.md) and
follow it for the implementation. The PR need not exist yet; the branch is the delivery.
Retrieve its instructions the ordinary way. Only when the user explicitly asks for compact
apply, also read [references/mate-compact-apply.md](references/mate-compact-apply.md) and
use its transport.

## Step 4: Hand off

End the response with a final `## Next steps` section: numbered required actions in
execution order, with exact commands and known change names, prerequisites first.
Summaries, evidence, warnings, optional work, and deferred context go above it; nothing
follows it. Listing an action never invokes it. Never offer the user an optional command, in or above the section; optional work appears above it only as a skill invocation labelled optional.

**Skill invocation.** Skill invocations here use `/name`, the syntax of Claude Code
and Cursor and the fallback. When the current runtime uses another syntax, swap only
the prefix: `@name` in OpenCode, `$name` in Codex, `/skill:name` in Pi. Only the
user's statement or the harness's own identity sets the runtime, never a skill's
folder or an older example. Arguments, commands, paths, and order stay, and naming
never invokes.

- Above the section, label `/mate-show-me` and `/mate-simplify-code` as optional, in
  any order; they are not prerequisites for archive.
- In the section, list `/mate-archive-change <change-name>`, after any required work
  still open (a failing check, an unanswered question). Name the archive action only
  there: omit the reference's completion sentence that also points to
  `/mate-archive-change`.
- Several changes on one branch: list their archives in dependency order, and say above
  the section that this order avoids an advisory archive warning; it is not a gate.

```text
Optional, any order: /mate-show-me acme-queue, /mate-simplify-code.

## Next steps
1. /mate-archive-change acme-queue
```

## Guardrails

- Never push, open a PR, or merge on the user's behalf.
- Never record a protected branch except as an explicit direct delivery.
- The forge token, when one is used by `mate artifact link`, is never printed or
  written; do not read or echo `MATE_GIT_TOKEN`.
