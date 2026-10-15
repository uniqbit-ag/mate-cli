# Changelog

## Unreleased

### OpenSpec output regenerates only on `mate companion setup` and `mate companion update`

- **Behavior change:** launches no longer upgrade the `openspec` CLI to `@latest` or run `openspec config reset`, `openspec init --force`, and `openspec update --force`. Those commands rewrote the committed `openspec-*` skills and `/opsx` commands in the background, so teammates on different CLI versions kept overwriting each other's files. A new OpenSpec release now reaches a companion only when someone runs `mate companion update` (or `mate companion setup`) and commits the result.
- A launch reads the `metadata.generatedBy` version from the companion's committed OpenSpec skills. When the installed `openspec` is older, Mate runs `npm install -g @fission-ai/openspec@<version>`, so every developer catches up to the version the last companion update generated with. A newer installed CLI is never downgraded, and pinned deployments skip the install. A failed install prints a warning with the manual command, and the launch continues.
- Launches still deploy Mate-owned skills and sync Mate schemas and the `config.yaml` rule.
- A runtime added by editing `framework.yaml` by hand gets its OpenSpec skills on the next `mate companion setup` or `mate companion update`.
- Every OpenSpec process Mate starts, including the `openspec` wrapper agents call, runs with `OPENSPEC_TELEMETRY=0` and `OPENSPEC_NO_UPDATE_CHECK=1`. OpenSpec's "update available" hint was wrong advice inside Mate, which decides the version.

### Delta specs pass `openspec validate --strict` on OpenSpec 1.14.2

- OpenSpec 1.14.2 reports any text above a delta spec's first `## ` section, which made every Mate change fail `openspec validate --strict`. Delta specs now carry their metadata (`change`, `capability`, and paired `scopes`) in a leading `<!-- mate:delta … -->` comment instead of YAML frontmatter, and the `mate-v1` instruction no longer asks for `← [[proposal]]` or `Applies to:` lines. The comment drops the delta `type` and `tags`.
- The `mate-v1` (version 10) and `mate-minimal` (version 4) delta templates, their `specs` instructions, `openspec/mate-conventions.yaml`, and Mate's `rules.specs` entry describe the comment. Existing companions pick them up on their next capability sync.
- `mate artifact publish` reads a delta's `scopes` from the comment, and still from frontmatter, so deltas in changes written before this release still publish. A `mate:delta` comment copied onto a main spec is replaced with canonical frontmatter, as a copied delta frontmatter block already was.

### TokenSave indexing heals an empty store

- `mate cap index`, and the indexing step of managed launches, now runs `tokensave init` whenever the Working Repository has no `.tokensave/tokensave.db`. Before, an empty or half-created `.tokensave/` folder counted as initialized, so every launch ran `tokensave sync` and failed with "no TokenSave index found".

### OpenSpec names the Working Repository as an edit root

- Mate registers the Companion Repository as an OpenSpec store and projects a store pointer (`openspec/config.yaml`) into each wrapped Working Repository. The pointer's `openspec/` folder is hidden from Git through `.git/info/exclude` (`/openspec/`), since all planning, including archived changes and canonical specs, lives in the companion's store. An earlier `/openspec/config.yaml` line is replaced on the next refresh. Run from inside the repository, `openspec status` now reports `actionContext.allowedEditRoots` as `[<working repo>, <companion>]` instead of the companion alone, so apply flows no longer refuse product-code edits.
- Existing repositories heal on their next `mate claude`, `mate opencode`, `mate wrap`, or other Mate command that refreshes the projection.
- Wrap-only users who never launch through Mate run `mate wrap` once. Until then, the `openspec` wrapper prints a one-line hint on stderr and keeps working as before.
- `.openspec-store/` is added to the companion's managed `.gitignore`. It holds the machine-local store id.
- The pointer is never written when the Working Repository has its own OpenSpec root (`openspec/specs/`, `openspec/changes/`, or its own `openspec/config.yaml`), or when its `.gitignore` re-includes the `openspec/` folder. In each case `mate wrap` prints a warning.
- `mate wrap` and managed launches now print a warning for every projection entry that fails without failing the operation. Before, these failures were dropped silently.
