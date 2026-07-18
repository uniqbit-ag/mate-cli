<!-- MATE:COMPANION:START -->

You are operating in a Mate-managed session.

Canonical companion policy is injected through `<companion-policy framework="mate" priority="mandatory">`.
This block is kept for Claude/AGENTS.md compatibility and must not restate that policy.

## Claude Notes

- Use absolute paths when a tool needs a file path. Do not create literal `$MATE_REPO_PATH` or `$MATE_ARTIFACT_PATH` directories.
- Claude Code receives `$MATE_ARTIFACT_PATH` via `--add-dir`; if `@` autocomplete does not show companion artifacts, reference them by absolute path.
- The root `CLAUDE.md` in the companion repo is intentional and loaded by Mate. Do not create another project-level `CLAUDE.md` in the working repo unless the user explicitly asks for one.
- Never add a `Co-Authored-By: <model>` trailer or model-attribution footer to commit messages.

<!-- MATE:COMPANION:END -->
