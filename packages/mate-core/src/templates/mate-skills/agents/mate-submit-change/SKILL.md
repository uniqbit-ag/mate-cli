---
name: mate-submit-change
description: Submit a finished change with its whole Workset through mate artifact submit, which records its delivery, validates it, and pushes its Delivery Group's change folders for publication before the merge, so anyone can publish it once the branch merges. Use when the user wants to submit, finish, finalize, or close out an implemented change.
allowed-tools: Bash(mate:*), Bash(git:*)
license: MIT
compatibility: Requires the mate CLI and the openspec capability enabled.
metadata:
  author: mate
  version: "1.0"
---

# Mate Submit Change

The Submit change stage of the Delivery Path. Submitting is
allowed **before** the delivery branch merges: nothing is archived and no canonical
spec changes. Submit is one act on the whole Workset: it validates the change, takes
along the other active changes of its **Delivery Group**
(`<repository>/<delivery-branch>`, one per Workset) whose tasks are all checked, and
pushes the group's change folders in one secret-scanned commit that sets
`state: submitted` in each `delivery.yaml`, to the companion's pending branch, the
inbox `mate/inbox`. A Workset lands together or not at
all, and a change is `submitted` only once it is on that branch. The commit is built in a temporary worktree;
the checkout is not touched and keeps the folders, uncommitted, until their published archive arrives. Once the branch merges, anyone can publish the
group with `mate-publish-artifact`, from any machine.

## Steps

1. **Submit.**

   ```bash
   mate artifact submit "<change-name>" --json
   ```

   Run it from the companion or the linked Working Repository. It shows warnings,
   records the branch's final head and checks its merge state in Git, writes the change's
   `delivery.yaml`, and runs `openspec validate --strict` itself. Do not run
   `openspec archive`. The result is an array with one entry per change, the ones
   submitted with it included.

2. **Answer by `status`.**

   - `submitted` → the group's folders are on `pendingBranch`; `pushed` says whether
     this run pushed them (false when they were there unchanged).
   - `waiting` → nothing was pushed and no state changed: the Workset is not ready.
     Its other changes named in `waitingFor` have open tasks or failed their check.
     Report them and what each needs: finish it, or drop it with
     `mate artifact submit --drop` only when the user says it is abandoned.
   - `needs-branch` → nothing was submitted. Ask the user which branch delivers the
     change, suggesting `suggestedBranch` when it is set, and re-run with exactly one
     of:
     - `--branch "<branch>"` — a protected branch only with `--direct`, after the user
       explicitly confirms a direct delivery;
     - `--not-applicable "<reason>"` — for a specification-only change;
     - `--skip-branch` — when the user skips the question; publication will ask again.
   - `failed` → no state changed. Report the `message`: a failed check
     (`reason` `check-failed`, typically a validation error) or a failed push. For
     `secret`, report each finding's path, line and rule, never a value. Re-running
     submit retries; an unchanged resubmit adds no commit.

   A non-zero exit without a result is a refusal; report its message. When it names
   uncommitted changes, the branch already counts as merged while its work tree holds
   modified tracked files: tell the user to commit or stash them and submit again.
   Never commit, stash or discard them yourself.

3. **Report.** Relay every entry of `warnings` first: another active change that
   modifies the same requirement, a declared dependency that is not submitted yet,
   planning artifacts its schema requires that are missing (`incomplete-planning`), or a
   branch that names no Delivery Group. Warnings never block. Then report the `group`
   and the delivery: each branch with its merge result and source (`git` or
   `user`) and PR link, or the not-applicable reason. An open or unknown merge is
   information, not a failure and not an action: never offer to record it
   (`mate artifact link … --confirm-*`); publication asks the merge question; a
   `likely-merged` outcome is only a suggestion that publication confirms with the user.

4. **Hand off.**
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

   For a `waiting` group, list finishing each change of `waitingFor` first, then
   `/mate-submit-change <change-name>` again. When the
   delivery branch is not merged yet, list merging it before `/mate-publish-artifact`,
   and say above the section that publication, not submit, waits for the merge. Never
   commit, push, open a PR, or merge for the user.

   ```text
   ## Next steps
   1. Merge workset/acme-queue
   2. /mate-publish-artifact
   ```

## Guardrails

- Submit never publishes: never commit, tag, or push yourself, and never archive. The
  canonical specs change only through `mate-publish-artifact`.
- Never check off tasks or drop a change so that a waiting Workset submits.
