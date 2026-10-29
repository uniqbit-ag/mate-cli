---
name: mate-archive-change
description: Archive a change through mate artifact archive, which records its delivery, reports merge state and overlap warnings, and runs the OpenSpec archive, also before the merge. Use when the user wants to archive, finalize, or close out an implemented change.
allowed-tools: Bash(mate:*), Bash(git:*)
license: MIT
compatibility: Requires the mate CLI and the openspec capability enabled.
metadata:
  author: mate
  version: "1.0"
---

# Mate Archive Change

The Archive change stage of the Delivery Path. Archiving applies the change's delta
specs to the local canonical specs, so a feature's later changes build on it. It is
allowed **before** the delivery branch merges: publication, not archive, waits for the
merge. Archiving is local and uncommitted; it publishes nothing.

## Steps

1. **Archive.**

   ```bash
   mate artifact archive "<change-name>" --json
   ```

   Run it from the companion or the linked Working Repository. It shows warnings,
   refreshes merge state from the forge when a token is available, writes the change's
   `delivery.yaml`, and runs `openspec archive` itself. Do not run `openspec archive`
   separately.

2. **Answer a missing branch.** When the result's `status` is `needs-branch`, nothing
   was archived. Ask the user which branch delivers the change, suggesting
   `suggestedBranch` when it is set, and re-run with exactly one of:

   - `--branch "<branch>"` — a protected branch only with `--direct`, after the user
     explicitly confirms a direct delivery;
   - `--not-applicable "<reason>"` — for a specification-only change;
   - `--skip-branch` — when the user skips the question; publication will ask again.

3. **Report.** Relay every entry of `warnings` first: another active change that
   modifies the same requirement, or a declared dependency that is not archived yet.
   Warnings never block. Then report the archive `path` and the delivery: each branch
   with its merge result and source (`forge` or `user`) and PR link, or the
   not-applicable reason. An open or unknown merge is information, not a failure.

4. **Hand off.** Name `/mate-publish-artifact` as the next step and say that
   publication holds the archive back until its delivery branch is merged. Do not
   invoke it.

When `status` is `failed`, report the message (typically incomplete tasks or a
validation error) and stop.

## Guardrails

- Never commit, tag, or push; publication is `mate-publish-artifact`.
- A merger account is provenance, never an artifact review.
- Do not read or echo `MATE_GIT_TOKEN`.
