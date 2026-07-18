# OpenSpec Finish Reference

Use this reference when you need the OpenSpec-specific parts of `mate-openspec-artifact-finish`: change lookup, resumable archive behavior, JSON field meanings, and conflict recovery.

## OpenSpec Input Rules

- Input is an OpenSpec change name.
- Prefer the archived change named in the triggering context.
- Otherwise, run `openspec list --json` and use the sole active change.
- Ask the user only when multiple active changes remain ambiguous.

## Resumable Behavior

The CLI is **resumable**.

If the change is already archived — because the developer ran `openspec archive` by hand, or because a prior finish partially completed — `mate artifact finish` detects the existing:

```text
openspec/changes/archive/<date>-<name>/
```

It then skips the archive step and continues from commit → tag → push. In that case the result includes `resumed: true`.

This means a developer can archive manually first and still rely on `mate artifact finish` for the commit/tag/push tail.

## JSON Contract

Always invoke with `--json` and parse the single JSON line the command prints:

```json
{
  "type": "openspec",
  "name": "my-change",
  "anchorName": "2026-07-14-my-change",
  "tag": "openspec/2026-07-14-my-change",
  "resumed": false,
  "step": "done",
  "status": "ok",
  "conflictedPaths": [],
  "local": { "committed": true, "tagged": true, "pushed": true },
  "message": "..."
}
```

- `step` is the pipeline step the result refers to: `validate`, `complete-guard`, `produce`, `cap-sync`, `commit`, `sync-remote`, `tag`, `push`, `done`.
- `produce` is the artifact-specific transform. For OpenSpec, `produce` means archive.
- `status` is one of:
  - `ok`: finished successfully
  - `conflict`: rebase handoff for agent resolution
  - `error`: a step failed
  - `skipped`: local-only finish, usually from `--no-push`
- `resumed` is true when the artifact was already produced and the engine skipped that step.
- `conflictedPaths` lists files with rebase conflicts.
- `local` tells you exactly what exists locally: `committed`, `tagged`, `pushed`.

## Artifact-Scoped Guard Workflow

The finish command is scoped to the requested artifact and mutates only the companion repository.

- Unrelated staged or unstaged companion changes must be preserved and do not require `--force`.
- `--force` is only for an incomplete artifact when the user explicitly approves bypassing the
  `complete-guard`; it is not a workaround for unrelated dirty state.
- If the result reports a conflict involving the artifact's own paths, stop and show the paths to
  the user. Do not commit, reset, stash, or overwrite those files without user direction.
- Never use the working repository as a finish Git target. It is only the explicit context for
  capability indexing.

## Interpreting Results

- `ok`: Report success using `anchorName` and `tag` from JSON. Mention `resumed` if true.
- `skipped`: Report that the commit and tag were created locally but not pushed.
- `error`: Surface `step` and `message`, then explain the retained local state from `local`.

Failure behavior matters:

- Capability-sync and commit failures restore only the produced artifact paths to the pre-finish HEAD; unrelated companion changes are preserved.
- If the provider fails before it can report produced paths, partial output is retained for inspection and may be resumable.
- On a resumed run, an already-existing manual archive is not discarded.
- A `push` failure after tag creation retains the commit and tag for retry.

## OpenSpec Conflict Workflow

If `status` is `conflict`, do **not** rerun `mate artifact finish`.

At that point:

- the change is already archived
- the finish commit already exists
- no tag was created yet
- nothing was pushed

Use `conflictedPaths` to resolve the rebase. All Git commands in this recovery path must run against the companion repository, never the working repository.

Typical conflicted files live under:

```text
openspec/specs/
openspec/changes/archive/
```

### Recovery Steps

1. Inspect each conflicted path.
2. Resolve the conflict. The archived change's regenerated specs are the intended new state; reconcile them with whatever advanced on the remote.
3. If the resolution is not obvious, ask the user rather than guessing.
4. Stage the resolved files and continue the rebase:

```bash
git add <resolved-paths>
git rebase --continue
```

5. Finish the remaining steps manually using the exact `tag` and `anchorName` from the JSON result:

```bash
git tag -a "<tag>" -m "Finish <anchorName>"
git push --follow-tags
```

6. Report the completed finish.

If the user prefers to abort instead of resolving, run:

```bash
git rebase --abort
```

Then explain that the finish commit remains on the branch untagged and unpushed for manual handling.

## OpenSpec Guardrails

- Never scrape human-readable output when `--json` is available.
- Never recompute `tag` or `anchorName`; use the JSON values verbatim.
- Never auto-resolve a spec conflict you do not understand.
