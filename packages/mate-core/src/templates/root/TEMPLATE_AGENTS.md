<!-- MATE:COMPANION:START -->

- When reporting information to me, be extremely concise and sacrifice grammar for the sake of concision. Apply this same preference to JSDoc.
- Code comments: JSDoc format only (`/** ... */`), never `//`. Sparse — only non-obvious invariants or constraints, never restated artifact rationale.
- Never add a `Co-Authored-By: <model>` trailer or model-attribution footer to commit messages.
- Never commit, push, or open a pull request in the working repo (`$MATE_REPO_PATH`) unless the user explicitly asks for it.
- Never connect to a database (local or remote), touch live/external systems (deploys, infra), or take destructive/irreversible actions without asking the user first.

<!-- MATE:COMPANION:END -->
