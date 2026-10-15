# Changelog

## Unreleased

### Secret guardrails (breaking)

- Agents in Mate-managed sessions can no longer read, write, or edit secret files (`.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_ecdsa`, `id_ed25519`, `.netrc`, `.pgpass`, `.npmrc`), and shell commands that name one are blocked, as are Grep searches inside a secret file or with a glob aimed at secret files (such as `.env*`). `.env.example`, `.env.sample`, `.env.template`, and `.env.dist` stay readable. The Claude hook and the OpenCode middleware enforce this, and Mate's managed deny rules back it up.
- Content an agent writes into the Companion Repository is scanned with secretlint's recommended preset and blocked when it contains a secret.
- `mate artifact publish` scans the files it would commit and stops at a new `secret-scan` step when it finds a secret. `--json` results carry `secretFindings` (path, line, rule id; never the value).
- TokenSave's exclude list keeps secret files out of its index. Every Graphify extraction, including ones agents run through the `graphify` wrapper, leaves secret files out through a Mate-managed `.graphifyignore` region and `--exclude` arguments; any secret that still reaches the output is removed from it, and the rest of the graph is kept. A secret never stops Graphify.
- Agents get a new `secret-handling` rule in the companion guidance.
- Configure it in the companion's `framework.yaml` under `secrets` (`guardrails`, `deny`, `allow`). `secrets: { guardrails: false }` turns it all off. See the Secret Guardrails page in the docs.

### mate-v1 delta specs drop the backlink lines

- The `mate-v1` schema no longer tells agents to put a `← [[proposal]]` backlink or an `Applies to:` line below a delta spec's title. OpenSpec 1.14.2 reports text above the first `## ` section, which archive drops, and `openspec validate --strict` failed on it.

### TokenSave indexing heals an empty store

- `mate cap index`, and the indexing step of managed launches, now runs `tokensave init` whenever the Working Repository has no `.tokensave/tokensave.db`. Before, an empty or half-created `.tokensave/` folder counted as initialized, so every launch ran `tokensave sync` and failed with "no TokenSave index found".

### OpenSpec names the Working Repository as an edit root

- Mate registers the Companion Repository as an OpenSpec store and projects a store pointer (`openspec/config.yaml`) into each wrapped Working Repository. The pointer's `openspec/` folder is hidden from Git through `.git/info/exclude` (`/openspec/`), since all planning, including archived changes and canonical specs, lives in the companion's store. An earlier `/openspec/config.yaml` line is replaced on the next refresh. Run from inside the repository, `openspec status` now reports `actionContext.allowedEditRoots` as `[<working repo>, <companion>]` instead of the companion alone, so apply flows no longer refuse product-code edits.
- Existing repositories heal on their next `mate claude`, `mate opencode`, `mate wrap`, or other Mate command that refreshes the projection.
- Wrap-only users who never launch through Mate run `mate wrap` once. Until then, the `openspec` wrapper prints a one-line hint on stderr and keeps working as before.
- `.openspec-store/` is added to the companion's managed `.gitignore`. It holds the machine-local store id.
- The pointer is never written when the Working Repository has its own OpenSpec root (`openspec/specs/`, `openspec/changes/`, or its own `openspec/config.yaml`), or when its `.gitignore` re-includes the `openspec/` folder. In each case `mate wrap` prints a warning.
- `mate wrap` and managed launches now print a warning for every projection entry that fails without failing the operation. Before, these failures were dropped silently.
