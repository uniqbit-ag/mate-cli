---
name: mate-explore-change
description: Explore a change with its Working Repository and Area resolved from the companion context map, and suggest slicing a large feature into several changes. Builds on the OpenSpec explore workflow. Use when the user wants to explore, investigate, or think through a change before proposing it.
allowed-tools: Bash(mate:*), Bash(openspec:*), Bash(git:*)
license: MIT
compatibility: Requires the mate CLI and the openspec capability enabled.
metadata:
  author: mate
  version: "1.0"
---

# Mate Explore Change

The Explore change stage of the Delivery Path. It runs the OpenSpec explore workflow
and adds two things: the scope comes from the companion context map, and a feature too
large for one change is suggested as several.

## Steps

1. **Follow the OpenSpec workflow.** Read
   [references/openspec-explore.md](references/openspec-explore.md) and follow it for the
   exploration itself. When a `PRE-EXPLORE HANDOFF` block is in this conversation, treat
   its Confirmed points as settled and start from its Unresolved questions and
   Assumptions.

2. **Resolve scope from the context map.** Before reading code, identify the canonical
   Working Repository (`org/repository` from its Git remote) and the repository-relative
   Area (the owning package root in a monorepo). Read the Companion Repository's
   `CONTEXT-MAP.md`, then only the repository-scoped map for that Working Repository,
   and load only the contexts it maps to that Area. Use their vocabulary in the
   exploration. When the map has no entry for the Area, say so instead of borrowing
   another Area's context.

3. **Suggest slicing when the feature is large.** Slicing test: a feature needs
   slicing when it spans several Areas, several independent behaviours, or more work
   than one review can hold (roughly more than 10 tasks or 400 changed lines).
   Several Areas that only work together stay one change with a scope per Area. When
   the explored direction passes the test, propose slices: one change per slice,
   each reviewable and archivable on its own, in dependency order. Name the
   dependencies between slices; they become `dependsOn` entries when the changes are
   proposed. Several slices may share one delivery branch. Slicing is a suggestion;
   the user decides.

4. **Hand off.** End by naming `/mate-propose-change` as the next step, once per agreed
   slice. Do not invoke it.

## Boundary

Exploration writes no product code. Agent artifacts written while exploring go to the
Companion Repository, never the Working Repository.
