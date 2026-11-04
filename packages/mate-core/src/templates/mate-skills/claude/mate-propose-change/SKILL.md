---
name: mate-propose-change
description: Propose a change with its schema chosen by the minimal eligibility test (mate-minimal or mate-v1) and one change per agreed slice. Builds on the OpenSpec propose workflow. Use when the user wants to turn an explored direction into a change proposal, or revise an existing change's plan.
allowed-tools: Bash(mate:*), Bash(openspec:*), Bash(git:*)
license: MIT
compatibility: Requires the mate CLI and the openspec capability enabled.
metadata:
  author: mate
  version: "1.0"
---

# Mate Propose Change

The Propose change stage of the Delivery Path. It runs the OpenSpec propose workflow
and adds the schema choice and one change per slice. Its revise mode reworks the plan
of a change that already exists.

## Step 0: Choose the mode

Use **Revise mode** when the named change already exists, or the user asks to revise,
reconcile, or fold feedback or new decisions into a change's plan. Otherwise run the
propose steps below.

## Steps

1. **Choose the schema.** Use `mate-minimal` (specs and tasks only) when every
   statement holds; otherwise use `mate-v1` (proposal, specs, design, tasks):

   - Intent and scope are clear, with nothing left to explore.
   - The change stays within one Area.
   - It is low risk: no new dependency, no data-model or public API change, and no
     security, performance, or migration concern.

   Public API includes command names, flags, exit codes, JSON output fields, config
   keys, and exported package symbols.

   State the result and the failing statement, if any, in one line. The user may
   override it.

2. **One change per slice.** Slicing test: a feature needs slicing when it holds
   several behaviours that can each ship and be reviewed on their own, or more work
   than one review can hold (roughly more than 20 tasks or 800 changed lines).
   Several Areas alone are no reason to slice: they stay one change with a scope per
   Area. When exploration agreed on several slices, propose one change per slice,
   each with its own name. When no slices were agreed and no decision to keep one
   change was made (in exploration or a PRE-EXPLORE HANDOFF), apply the slicing test
   before writing anything. Only when it clearly passes, suggest slices in dependency
   order, naming their `dependsOn` entries, and write no artifact until the user
   agrees to the slices or keeps one change. A borderline case counts as one change:
   state in one line why, and continue. If the test clearly passes but the slice
   boundaries are unclear, suggest `/mate-explore-change` instead of guessing slices.
   Record a slice's dependency on an earlier change as a `dependsOn` list in the
   frontmatter of its first artifact, for example `dependsOn: [add-graph-model]`; archive
   later warns while a dependency is still unarchived.

3. **Follow the OpenSpec workflow.** Read
   [references/openspec-propose.md](references/openspec-propose.md) and follow it with the
   chosen schema (pass `--schema <schema>` when creating the change).

4. **Hand off to human review.** Reviews are done by people, not by a skill.
   End the response with a final `## Next steps` section: numbered required actions in
   execution order, with exact commands and known change names, prerequisites first.
   Summaries, evidence, warnings, optional work, and deferred context go above it; nothing
   follows it. Listing an action never invokes it.

   **Skill invocation.** Skill invocations here use `/name`, the syntax of Claude Code
   and Cursor and the fallback. When the current runtime uses another syntax, swap only
   the prefix: `@name` in OpenCode, `$name` in Codex, `/skill:name` in Pi. Only the
   user's statement or the harness's own identity sets the runtime, never a skill's
   folder or an older example. Arguments, commands, paths, and order stay, and naming
   never invokes.

   List the artifacts to review in schema order (Review proposal, Review specs, Review
   design, Review tasks for `mate-v1`; Review specs and Review tasks for
   `mate-minimal`), then `/mate-apply-change <change-name>` after that review. Never
   describe validation as approval.

   - **Remaining slices:** when recommending them next, list
     `/mate-propose-change <slice>` per slice in dependency order; otherwise name them
     above the section as deferred.
   - **Dependencies:** a `dependsOn` change with unfinished work (open tasks or an
     outstanding check) gets its named action listed before applying this change. A
     dependency that is implemented but unarchived does not block apply: say above
     the section that archiving it first avoids an archive warning.

   ```text
   Validation passed; validation is not approval.

   ## Next steps
   1. Review specs: openspec/changes/acme-queue/specs/
   2. Review tasks: openspec/changes/acme-queue/tasks.md
   3. After your review: /mate-apply-change acme-queue
   ```

## Revise mode

Revises the planning artifacts a change already has, for example after a person reviewed
them. In this mode the skill is not a Delivery Path stage. Read
[references/mate-revise.md](references/mate-revise.md) and follow it; it loads the OpenSpec
workflow in [references/openspec-update-change.md](references/openspec-update-change.md).
Read neither when proposing a new change.
