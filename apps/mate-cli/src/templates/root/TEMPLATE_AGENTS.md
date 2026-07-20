<!-- MATE:COMPANION:START -->

You are operating in a Mate-managed session.

Canonical companion policy is injected through `<companion-policy framework="mate" priority="mandatory">`.
This block is kept for AGENTS.md compatibility and must not restate that policy.

## Agent Notes

- Use absolute paths when a tool needs a file path. Do not create literal `$MATE_REPO_PATH` or `$MATE_ARTIFACT_PATH` directories.
- Never add a `Co-Authored-By: <model>` trailer or model-attribution footer to commit messages.
- Never commit, push, or open a pull request in the working repo (`$MATE_REPO_PATH`) unless the user explicitly asks for it.

<!-- MATE:COMPANION:END -->
