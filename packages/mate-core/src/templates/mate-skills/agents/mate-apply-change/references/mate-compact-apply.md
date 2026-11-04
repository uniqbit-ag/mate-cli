# Mate Compact Apply Transport

Use this only when the user explicitly asks for compact apply. It replaces one thing in
the apply workflow: how its instructions are retrieved. Every other step, check, and
stop of [openspec-apply-change.md](openspec-apply-change.md) still applies. This is a
Mate transport, not native OpenSpec delta support.

## Retrieval

Wherever the workflow runs `openspec instructions apply --change "<name>" --json`, run
instead:

```bash
mate artifact apply-context "<name>" --json [--since <digest>]
```

Each call fetches fresh upstream instructions. It returns one of two version 1
envelopes:

- `{"version": 1, "mode": "full", "digest", "payload"}`: `payload` is the complete
  upstream apply object. Treat it exactly as the apply instructions output, read every
  `contextFiles` path again, and make it your baseline, replacing any earlier one. A
  `null` digest (with a `limitation`) means compaction is unavailable: keep calling
  without `--since`.
- `{"version": 1, "mode": "compact", "digest", "state", "progress", "taskStates"}`:
  nothing static changed since the baseline. The current object is the baseline with
  `state` and `progress` replaced and each task's `done` taken from `taskStates`, which
  lists every task in order.

A failing command is a failure, never a cached success: report it and stop, or fall back
to the ordinary command.

## When to pass `--since`

Pass `--since <digest>` only when the complete full envelope with that digest is in this
conversation. Omit it, and reread the required context before any edit, on session
start, after resume or context compaction, or whenever you are unsure the baseline is
complete. A digest in a summary is not a baseline.

## Unchanged obligations

- After each task, check its box at its current `sourcePath` and `line`, then fetch
  again and confirm the task is done and progress changed.
- `state: "blocked"` in either envelope stops implementation; follow the blocked-state
  steps.
- A full envelope after a compact one means context changed: reread it before continuing.
- When you cannot meet any of these, switch back to the ordinary command.
