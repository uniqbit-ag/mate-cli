---
name: mate-openspec-backfill
description: Reverse-engineer an OpenSpec spec for one existing feature and emit a ready-to-finish backfill change. Use when the user wants to backfill, document, or spec existing or legacy behavior that has no spec yet.
allowed-tools: Bash(openspec:*), Bash(mate:*)
license: MIT
compatibility: Requires the mate CLI and the openspec capability enabled.
metadata:
  author: mate
  version: "1.0"
---

Create a spec for one feature that already exists in the working repository. The run ends with a standard ready-to-finish change — it never edits main specs and never finishes.

## Scope rules

- **One named feature per run.** Refuse Area-wide or repository-wide sweeps; ask the user to name a single feature and run the skill once per feature.
- **Interactive by design.** Every ambiguity and every suspected bug becomes a user question. Do not run this skill unattended.

## Steps

1. **Scope.** Map the named feature to code: entry points, callees, tests. Use whatever exploration tooling this project has enabled (code-graph or index tools when present, otherwise search and targeted reading) — assume no specific capability is installed. Then check `openspec/specs/` for an existing capability covering this domain — prefer extending it (`MODIFIED`/`ADDED` deltas) over minting a new capability id.

2. **Sweep.** Extract candidate behaviors and tag each finding:
   - `[test-backed]` — an existing test verifies it (strongest; scenarios translate almost directly from tests)
   - `[code-only]` — observable in code but untested
   - `[inferred]` — assumed intent without direct evidence

   Every candidate requirement needs at least one citation: a test name or `file:line`. Docs and comments corroborate but never stand alone. `[inferred]` findings are not requirements — they become questions for step 3.

3. **Ask.** Batch the open questions to the user:
   - Behavior that looks unintended → the user rules **spec the actual behavior** or **spec the intent** (with a follow-up fix change). Suspected bugs never silently become requirements.
   - `[inferred]` findings → confirm, demote to out-of-scope, or convert to a question the emitted proposal records as open.

4. **Emit.** Create the change and build its artifacts in dependency order:

   ```bash
   openspec new change "backfill-spec-<capability>"
   openspec status --change "backfill-spec-<capability>" --json
   openspec instructions <artifact-id> --change "backfill-spec-<capability>" --json
   ```

   The artifact set comes from the active schema (`schemaName` in the status JSON) — never assume a fixed artifact list. Follow each artifact's returned instructions and template, and state the active schema in the proposal so reviewers know which workflow produced the change. Map the backfill roles onto whatever artifacts the schema defines:

   | Backfill role                                                                                  | Typical artifact (mate-v1 example) |
   | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
   | Scope decisions and rulings from step 3                                                        | explore-brief.md                   |
   | "Documents existing behavior, no code changes" + open questions                                | proposal.md                        |
   | `ADDED`/`MODIFIED` requirements, behavior only, one citation each                              | specs/                             |
   | As-built evidence dossier: entry points, test inventory, `file:line` citations per requirement | design.md                          |
   | Verification checklist: one task per requirement, "confirm behavior at <citation>"             | tasks.md                           |

   The verification task artifact MUST open with this rule, verbatim, so the applying agent sees it without knowing this skill: "These are verification tasks for a docs-only backfill change. If a requirement fails verification, update the delta spec (reword, drop, or re-cite the requirement) — never modify code in this change. A real bug found here becomes a separate fix change."

   Requirements state observable contracts, never implementation detail ("propagates the child exit code", not "uses spawnSync").

5. **Stop.** Report the change as ready-to-finish and hand off:
   - Verify: `openspec-apply-change` works through tasks.md, checking each requirement against the code.
   - Finish: `mate-artifact-finish` applies the deltas to main specs and anchors the change.

## Guardrails

- Never write files under `openspec/specs/` — main specs change only through finished changes.
- Never invoke any finish flow (`mate artifact finish`, `openspec archive`); stop at ready-to-finish.
- Never emit a requirement without a citation, and never spec a suspected bug without the user's ruling.
- Keep capability ids opaque kebab-case; extend existing capabilities before creating new ones.
