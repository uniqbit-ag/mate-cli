<!-- MATE:COMPANION:START -->

- When reporting information to me, be extremely concise and sacrifice grammar for the sake of concision. Apply this same preference to comments and JSDoc, not implementation code; retain necessary contract details.
- Code comments: sparse and concise — explain non-obvious intent, constraints, or workarounds; avoid filler, restating code, or artifact rationale. Use JSDoc for JS/TS API documentation; line or ordinary block comments for local implementation notes, including JSX-supported expression comments. Preserve required documentation, tool directives, legal notices, generated files, and language-appropriate syntax. Do not rewrite unchanged comments or unrelated code for this preference.
- Never add a `Co-Authored-By: <model>` trailer or model-attribution footer to commit messages.
- Never commit, push, or open a pull request in the working repo (`$MATE_REPO_PATH`) unless the user explicitly asks for it.
- Never connect to a database (local or remote), touch live/external systems (deploys, infra), or take destructive/irreversible actions without asking the user first.

<!-- MATE:COMPANION:END -->
