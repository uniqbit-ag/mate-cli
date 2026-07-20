---
name: mate-openspec-artifact-finish
description: Finish a completed artifact in one step via `mate artifact finish`. Use when the user wants to finish, ship, or archive-and-push a completed artifact and anchor it with a dated revert tag.
allowed-tools: Bash(mate:*), Bash(git:*), Bash(openspec:*)
license: MIT
compatibility: Requires the mate CLI and the openspec capability enabled.
metadata:
  author: mate
  version: "1.2"
---

Finish a completed artifact as one deterministic mate workflow and leave a dated tag that makes rollback trivial.

## Workflow

`mate artifact finish` is the deterministic, non-interactive finish pipeline.

The CLI performs normal work; only conflict recovery requires agent judgment.

## Steps

1. **Resolve the artifact name.** Use the archived change named in the triggering context. If absent, use the single active OpenSpec change from `openspec list --json`. Ask only when multiple active changes remain ambiguous.

2. **Run the CLI.**

   ```bash
   mate artifact finish "<artifact-name>" --json
   ```

   Run it from the companion repository. Finish mutates only that repository; the linked working repository is capability-indexing context. Do not manually invoke `mate cap index`.

   Add `--force` only if the user explicitly wants to override the not-complete guard (validation is never bypassable). Unrelated companion changes are preserved and do not require `--force`. Add `--no-push` for a local-only finish.

3. **Parse the JSON result and branch on `status`.**

   For the exact field meanings and the provider-specific conflict path, read [references/openspec.md](references/openspec.md).

   - **`ok`** → Report success and mention whether it resumed from an already-produced artifact.
   - **`skipped`** → Report that the finish completed locally without pushing.
   - **`error`** → Surface the failing step and message, then explain what local state exists.
   - **`conflict`** → Follow the provider-specific conflict workflow in [references/openspec.md](references/openspec.md). Do not blindly rerun the finish command.

## Guardrails

- Do not ask the user for confirmation before running this skill or before the CLI pushes. Invoking `mate artifact finish` is pre-authorized end-to-end (commit, tag, push) as part of this workflow.
- Always pass `--json` and parse the result; do not scrape human-readable output.
- Never re-run `mate artifact finish` blindly after a `conflict`.
- Never auto-resolve a provider-specific conflict you do not understand — ask the user.
- Use the JSON fields the CLI returns; do not recompute names, dates, or tags by hand.
- Invoke the CLI as `mate`, never through a companion-local wrapper.
- Only the companion repository is a finish Git target; the working repository is an index input.
