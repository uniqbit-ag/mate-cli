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

2. **One change per slice.** Slicing test: a feature needs slicing when it spans
   several Areas, several independent behaviours, or more work than one review can
   hold (roughly more than 10 tasks or 400 changed lines). Several Areas that only
   work together stay one change with a scope per Area. When exploration agreed on
   several slices, propose one change per slice, each with its own name. When no
   slices were agreed, apply the slicing test before writing anything. If it passes,
   suggest slices in dependency order, naming their `dependsOn` entries, and write no
   artifact until the user agrees to the slices or keeps one change. If the slice
   boundaries are unclear, suggest `/mate-explore-change` instead of guessing slices.
   Record a slice's dependency on an earlier change as a `dependsOn` list in the
   frontmatter of its first artifact, for example `dependsOn: [add-graph-model]`; archive
   later warns while a dependency is still unarchived.

3. **Follow the OpenSpec workflow.** Read
   [references/openspec-propose.md](references/openspec-propose.md) and follow it with the
   chosen schema (pass `--schema <schema>` when creating the change).

4. **Hand off to human review.** Reviews are done by people, not by a skill. List the
   artifacts to review in schema order (Review proposal, Review specs, Review design,
   Review tasks for `mate-v1`; Review specs and Review tasks for `mate-minimal`), then
   name `/mate-apply-change` as the step after review. Do not invoke it, and never
   describe validation as approval.

## Revise mode

Revises the planning artifacts a change already has, for example after a person reviewed
them, and keeps them consistent with each other. In this mode the skill is
not a Delivery Path stage.

1. **Name the change.** Use the change the user names; otherwise infer it from the
   conversation, or list the active changes and ask.

2. **Follow the OpenSpec workflow.** Read
   [references/openspec-update-change.md](references/openspec-update-change.md) and follow
   it. Propose the requested edit together with the matching edits to the other
   artifacts, and write each one only after the user confirms it.

3. **Hand off.** When the change already has checked tasks, name `/mate-apply-change` to
   carry the revision into code; when every task is checked, name `/mate-archive-change`.
   Do not invoke them.

Guardrails:

- Planning artifacts only; never edit product code.
- Reviews are done by people. Never describe a revision or a passing validation as
  approval.
