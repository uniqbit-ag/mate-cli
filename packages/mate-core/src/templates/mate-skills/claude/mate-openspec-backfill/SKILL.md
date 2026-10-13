---
name: mate-openspec-backfill
description: Reverse-engineer an OpenSpec spec for one existing feature and write it directly to the canonical spec, ready to publish. Use when the user wants to backfill, document, or spec existing or legacy behavior that has no spec yet.
allowed-tools: Bash(openspec:*), Bash(mate:*), Bash(git remote:*), Bash(git diff:*)
license: MIT
compatibility: Requires the mate CLI and the openspec capability enabled.
metadata:
  author: mate
  version: "2.0"
---

# Mate OpenSpec Backfill

Specify one feature that already exists in the working repository. A backfill records behavior that already shipped, so the run writes the canonical spec `openspec/specs/<capability>/spec.md` directly and leaves it uncommitted. It never creates a change and never publishes; publication happens afterwards through `mate-artifact-publish`.

## Scope rules

- **One named feature per run.** Refuse Area-wide or repository-wide sweeps; ask the user to name a single feature and run the skill once per feature.
- **Interactive by design.** Every ambiguity and every suspected bug becomes a user question, and nothing is written before the user approves the review table. Do not run this skill unattended.

## Steps

1. **Scope.** Map the named feature to code: entry points, callees, tests. Use whatever exploration tooling this project has enabled (code-graph or index tools when present, otherwise search and targeted reading) — assume no specific capability is installed. Then check `openspec/specs/` for an existing capability covering this domain — prefer extending it in place over minting a new capability id.

2. **Sweep.** Extract candidate behaviors and tag each finding:
   - `[test-backed]` — an existing test verifies it (strongest; scenarios translate almost directly from tests)
   - `[code-only]` — observable in code but untested
   - `[inferred]` — assumed intent without direct evidence

   Every candidate requirement needs at least one citation: a test name or `file:line`. Docs and comments corroborate but never stand alone. `[inferred]` findings are not requirements — they become questions for step 3.

3. **Ask.** Batch the open questions to the user:
   - Behavior that looks unintended → the user rules **spec the actual behavior** or **spec the intent** (and the user may open a separate fix change). Suspected bugs never silently become requirements.
   - `[inferred]` findings → confirm, demote to out-of-scope, or drop.

4. **Review.** Before writing any file, present every drafted requirement in one table and wait for the user's approval:

   | Requirement                     | Evidence        | Citation                         |
   | ------------------------------- | --------------- | -------------------------------- |
   | Propagates the child exit code  | `[test-backed]` | `launch.test.ts` › "exits with…" |
   | Refuses an unknown framework id | `[code-only]`   | `src/launch.ts:142`              |

   Write only the requirements the user approves, worded as approved. A rejected requirement is not written. This table is the only place citations and evidence tags appear — they never go into the spec.

5. **Learn the spec format.** Never assume a spec format. Read it from the schema active in this OpenSpec root, so the run follows whichever workflow the project uses:

   ```bash
   openspec schema which <schema-name> --json
   ```

   - The active schema name is the `schema:` key in `openspec/config.yaml`. When the file or key is absent, it is OpenSpec's default, `spec-driven`.
   - In the returned `path`, read `schema.yaml` and find the artifact that generates the specs (`generates: specs/**/*.md`). Read its `instruction`, its `template` under `templates/`, and every reference file the instruction tells you to read (for example `openspec/mate-conventions.yaml`).
   - Those sources usually describe the **delta** a change writes. You write the **canonical** spec that archive would produce from it, so apply the schema's own delta-to-canonical rules: requirement blocks go under `## Requirements` instead of `## ADDED Requirements`, and frontmatter, per-requirement markers, and `## Purpose` take the canonical shape the schema or its references define. Leave out delta-only elements such as change backlinks and change or delta tags.
   - When a spec already exists under `openspec/specs/`, use it as a concrete example of the canonical shape, but follow the schema where the two disagree.
   - Derive any repository identity the format needs from the Git remote (`git remote get-url origin`), and any Area or scope value from the schema's rules. Never invent a format element the schema does not define.

6. **Write.** Write the approved requirements to `openspec/specs/<capability>/spec.md` in the format from step 5.

   **New capability.** Create the file with the schema's canonical frontmatter (when it defines one), a `## Purpose` section of one or two sentences, and a `## Requirements` section holding the approved requirements with their scenarios.

   **Existing capability.** Edit its `spec.md` in place: append new requirements under `## Requirements` and rewrite only the requirements the user's rulings change. Preserve every other requirement, the frontmatter, and the Purpose exactly.

   In both cases every requirement you write carries each per-requirement marker the schema requires (for example an `**Area:**` marker whose value appears in the spec's frontmatter). Requirements state observable contracts, never implementation detail ("propagates the child exit code", not "uses spawnSync"). The spec contains no citations, no `file:line` references, and no evidence tags.

7. **Validate.** Run:

   ```bash
   openspec validate <capability> --type spec
   ```

   Fix every reported error and re-validate until it passes. Do not hand off a spec that fails validation.

8. **Hand off.** Report the written path and show the uncommitted diff (`git diff -- openspec/specs/<capability>/`, or the file itself when it is new). Point the user to `mate-artifact-publish`: the spec appears there under **Drifted specs** and can be published on its own or with the rest.

## Guardrails

- Never create an OpenSpec change, change artifacts, or verification tasks, and never archive.
- Never commit, tag, push, or publish — never run `mate artifact publish`. Publication belongs to `mate-artifact-publish`.
- Never write any file before the user approves the review table.
- Never write a requirement without a citation in the review table, and never spec a suspected bug without the user's ruling.
- Never write citations or evidence tags into the canonical spec.
- Never hard-code a spec format: take it from the active schema on every run.
- Keep capability ids opaque kebab-case; extend existing capabilities in place before creating new ones, and never drop or reword requirements outside the named feature.
