---
name: mate-propose-change
description: Propose a change with its schema chosen by the minimal eligibility test (mate-minimal or mate-full) and one change per agreed slice. Builds on the OpenSpec propose workflow. Use when the user wants to turn an explored direction into a change proposal, or revise an existing change's plan.
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
   statement holds; otherwise use `mate-full` (proposal, specs, design, tasks):

   - Intent and scope are clear, with nothing left to explore.
   - The change stays within one Area.
   - It is low risk: no new dependency, no data-model or public API change, and no
     security, performance, or migration concern.

   Public API includes command names, flags, exit codes, JSON output fields, config
   keys, and exported package symbols.

   State the result and the failing statement, if any, in one line. The user may
   override it.

2. **One change per slice.** Slicing test: a feature needs slicing only when it
   holds more work than one review can hold (roughly more than 20 tasks or 800
   changed lines) and that work splits into behaviours that can each ship and be
   reviewed on their own. Several Areas alone are no reason to slice: they stay
   one change with a scope per Area. Cut as few slices as the work allows, each
   close to one review's size; merge a slice of fewer than about 10 tasks into its
   neighbour. When each slice needs the one before it to be useful, cut only where
   a reviewer needs a break, not at every behaviour. When exploration agreed on
   several slices, propose one change per slice,
   each with its own name. When no slices were agreed and no decision to keep one
   change was made (in exploration or a PRE-EXPLORE HANDOFF), apply the slicing test
   before writing anything. Only when it clearly passes, suggest slices in dependency
   order, naming their `dependsOn` entries, and write no artifact until the user
   agrees to the slices or keeps one change. A borderline case counts as one change:
   state in one line why, and continue. If the test clearly passes but the slice
   boundaries are unclear, suggest `/mate-explore-change` instead of guessing slices.
   Record a slice's dependency on an earlier change as a `dependsOn` list in the
   frontmatter of its first artifact, for example `dependsOn: [add-graph-model]`; submit
   later warns while a dependency is neither submitted nor published.

3. **Follow the OpenSpec workflow.** Read
   [references/openspec-propose.md](references/openspec-propose.md) and follow it with the
   chosen schema (pass `--schema <schema>` when creating the change). Never ask for a
   ticket; apply asks when it creates the branch. Once the change's delta specs are written,
   record the companion commit they were written against with
   `mate artifact link "<change-name>" --spec-base --json`, so a requirement someone changes
   meanwhile conflicts at publication instead of being overwritten. Then compare the
   requirements the delta specs modify or remove with `touches` of each change in
   `mate artifact pending --json`: for a match, tell the user the change and its
   `author`, since the one published second is refused as a conflict until resolved.

   **Dependent changes.** A `dependsOn` change that is submitted or active in this
   checkout counts as satisfied: its requirements are not in the canonical specs until
   it is published. Before writing the delta specs of a change with `dependsOn`, read
   the specs as they will be once that chain is published with
   `mate artifact project "<change-name>" --json`, and write `MODIFIED` requirements
   against that text, not against the canonical specs. A failing projection reports
   publication's reason; relay it.

4. **Close the stage.** Reviews are done by people, not by a skill, and validation is
   never approval. At the end of every run of this skill, for each change it proposed,
   run:

   ```bash
   mate workflow done mate-propose-change "<change-name>"
   ```

   It prints the next actions for the change. End the response with a final `## Next
   steps` section: numbered required actions in execution order, with exact commands and
   known change names, prerequisites first: required work of this run that is still
   open, then the actions the command printed, in its order. Summaries, evidence,
   warnings, optional work, and deferred context go above it; nothing follows it.
   Listing an action never invokes it. Never offer the user an optional command, in or
   above the section; optional work appears above it only as a skill invocation labelled
   optional, as the command's `optional:` line names it. If the command fails, report its
   problems and end without a `Next steps` section.

   **Skill invocation.** Skill invocations here use `/name`, the syntax of Claude Code
   and Cursor and the fallback. When the current runtime uses another syntax, swap only
   the prefix: `@name` in OpenCode, `$name` in Codex, `/skill:name` in Pi. Only the
   user's statement or the harness's own identity sets the runtime, never a skill's
   folder or an older example. Arguments, commands, paths, and order stay, and naming
   never invokes.

   Add only this skill's own required actions to the section:

   - **Remaining slices:** when recommending them next, list
     `/mate-propose-change <slice>` per slice in dependency order; otherwise name them
     above the section as deferred.
   - **Dependencies:** a `dependsOn` change with unfinished work (open tasks or an
     outstanding check) gets its named action listed before the printed ones. A
     dependency that is implemented but unsubmitted does not block apply: say above
     the section that submitting it first, with `/mate-submit-change`, avoids a submit
     warning.

## Revise mode

Revises the planning artifacts a change already has, for example after a person reviewed
them. In this mode the skill is not a Delivery Path stage. Read
[references/mate-revise.md](references/mate-revise.md) and follow it; it loads the OpenSpec
workflow in [references/openspec-update-change.md](references/openspec-update-change.md).
Read neither when proposing a new change.
