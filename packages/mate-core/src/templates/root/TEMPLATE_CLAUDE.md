<!-- MATE:COMPANION:START -->

You are operating in a Mate-managed session.

Canonical companion policy is injected through `<companion-policy framework="mate" priority="mandatory">`.
This block is kept for Claude/AGENTS.md compatibility and must not restate that policy.

## Claude Notes

- Use absolute paths when a tool needs a file path. Do not create literal `$MATE_REPO_PATH` or `$MATE_ARTIFACT_PATH` directories.
- When reporting information to me, be extremely concise and sacrifice grammar for the sake of concision. Apply this same preference to JSDoc.
- Code comments: JSDoc format only (`/** ... */`), never `//`. Sparse — only non-obvious invariants or constraints, never restated artifact rationale.
- Claude Code receives `$MATE_ARTIFACT_PATH` via `--add-dir`; if `@` autocomplete does not show companion artifacts, reference them by absolute path.
- MCP tools named `mcp__mate__mate__<tool>` are companion MCP servers delivered through the Mate gateway (`.mate/mcp.yaml` in the companion). `mate mcp status` inspects the gateway.
- The root `CLAUDE.md` in the companion repo is intentional and loaded by Mate. Do not create another project-level `CLAUDE.md` in the working repo unless the user explicitly asks for one.
- Never add a `Co-Authored-By: <model>` trailer or model-attribution footer to commit messages.
- Never commit, push, or open a pull request in the working repo (`$MATE_REPO_PATH`) unless the user explicitly asks for it.
- Never connect to a database (local or remote), touch live/external systems (deploys, infra), or take destructive/irreversible actions without asking the user first.

<!-- MATE:COMPANION:END -->
