# @uniqbit/mate-plugin-companion-mentions

A Mate plugin for Claude Code. While you work in a Working Repository, it lists Companion Repository files in Claude's `@` menu and attaches them as `@mate:<path>` mentions. It works in a session started with `mate claude` and in a plain `claude` session of a repository that Mate has wrapped for Claude.

## Install

```sh
mate plugin install @uniqbit/mate-plugin-companion-mentions
mate wrap      # or start a session with `mate claude`, which wraps first
claude
```

`mate plugin install` declares the package in the companion's `.mate/config/framework.yaml` and installs it. A declared plugin is always enabled. To turn it off, remove its entry under `plugins:`. The plugin takes no configuration: a `config` block with any key makes it fail to load, with a message naming the keys.

It needs:

- **A repository that Mate has wrapped for Claude, or a session started with `mate claude`.** `mate claude` wraps the repository first. The wrap enables the plugin for plain `claude` sessions in that repository, through the marketplace file the package ships (`mate-companion-mentions`). A plain `claude` session in a repository that Mate has not wrapped does not load it. `mate doctor` shows under Plain Sessions whether plain sessions load it.
- **A folder that Claude Code trusts**, for plain sessions. Claude Code ignores the repository's plugins until you accept its trust dialog for that folder.
- **Claude Code 2.1.292 or later.** Older versions start normally and ignore the plugin.

If you installed the `mate-companion-mentions` mod into Claude yourself, disable that copy. The plugin that Mate enables is a different plugin ID, so it does not replace yours, and with two enabled plugins of one name Claude leaves out the hooks of one of them.

## What it adds

- **`@` menu rows.** `@mate:` lists the companion's top level. Choosing a folder (`@mate:openspec/`) lists what it holds, and typing more narrows that list; when nothing there matches, the folder's whole tree is searched. Any other `@mate:` text (`@mate:tasks`) searches the whole companion, with up to 15 rows. After a bare `@`, up to three companion files whose names hold what you typed appear under Claude's own rows, plus a `mate:` row that switches to the companion. Rows are described as `<companion> (mate companion)`. Paths with spaces are written quoted: `@"mate:notes/meeting notes.md"`.
- **`@mate:` mentions.** When you send the prompt, `@mate:<path>` is read from the companion and attached like any other mention, line ranges (`#L10-20`) included. Claude is also told the file's path in the companion, so it can edit it. A folder mention attaches a list of what the folder holds, folders first, at most 200 names.
- **Notes instead of content.** A mention the plugin cannot attach attaches a note saying why, so Claude can tell you. This covers a missing path, `..`, a path starting with a drive (`C:`) or `//`, a link that leads outside the companion or nowhere, and a secret file. A leading `/` names the companion's top.

In a session that runs inside the companion, the plugin adds no rows, because Claude's own rows already list those files. A typed `@mate:` mention still attaches there.

## Which companion

In a session started with `mate claude`, the companion is the folder in `$MATE_ARTIFACT_PATH`, with links followed, and the policy comes from `$MATE_POLICY_JSON`. The launch always wins; the plugin then asks Mate nothing.

A plain session has no such variables, so the plugin asks Mate: it runs `mate session context --repo <session folder> --json` through Mate's runtime launcher, `~/.mate/runtime/bin/mate`, not through `PATH`, and waits at most 5 seconds. Mate reports a companion only when you registered it and it links the repository, so a projection file in a cloned repository is not enough. The `@` menu reuses an answer for up to 30 seconds; each sent `@mate:` mention asks again.

Without a companion, the `@` menu holds only Claude's own rows, and a `@mate:` mention attaches a note saying that the session has no mate companion and pointing to `mate doctor`. When Mate refuses the companion, the note names why.

## Secret files

The plugin follows the companion's secret policy, the same rules as Mate's other [secret guardrails](https://uniqbit-ag.github.io/mate-cli/docs/concepts/secret-guardrails): the default patterns, the companion's own `secrets.deny` and `secrets.allow`, and `secrets.guardrails: false`.

- A secret file is never offered as a row, and a folder mention's list leaves it out. A mention of one attaches a note naming the pattern it matches, and nothing is read.
- Matching ignores letter case, so `.ENV` is a secret file like `.env`.
- The path you name and, for a link, the path it leads to are both checked, each relative to the companion, for rows and mentions alike. Folders above the companion never match a pattern.
- In a plain session, a change to `secrets` applies from the next `@mate:` mention, and the menu follows within 30 seconds. A session started with `mate claude` keeps the policy from its launch, so the change reaches it at the next `mate claude`.

Without a readable policy the plugin offers no rows, and every `@mate:` mention attaches a note naming the cause:

- Mate is older than the plugin, or, in a plain session, Mate's launcher is missing or has no `session context` command. The note asks for a matching Mate version; running Mate at the plugin's version fixes it.
- In a plain session, `mate session context` does not answer within 5 seconds, or names a companion and then exits with a failure status. The note points to `mate doctor`, which checks the installation.

Your own Read deny rules still apply where a file lands.

## Details

| Part        | How                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File list   | `git ls-files --cached --others --exclude-standard` in the companion, minus files deleted from disk, so gitignored files stay out. When git fails or lists nothing, a folder walk that skips `.git` and `node_modules`. The list is kept for 30 seconds.                                                                                                    |
| Ranking     | In a folder: exact names, then prefixes, then the rest, folders first. Searching: exact name, name prefix, name part, path part, then letters in order; on a tie, folders first, then shorter paths. The folders Mate manages (`.mate/`, `.claude/`, `.agents/`, `.opencode/`, `.graphify/`) are searched only for text starting with `.`, and listed last. |
| Not offered | Secret files, links that lead outside the companion, nowhere or to a secret file, paths holding `#` (Claude reads it as a line range) or `\`, paths starting like a drive (`c:notes.md`), and paths that need quotes but hold `"`.                                                                                                                          |

Claude's own `@` rows always come first and start selected, so the `mate:` rows may need an arrow key.

## Platforms

macOS and Linux. On Windows, the path handling (drive letters, `\` separators, letter case) is covered by unit tests, but the plugin has not been tried there by hand.

## Develop

From this folder:

```sh
bun run test                                    # factory, pure logic, rule agreement, package contents
bun run test:hooks                              # the two commands below
claude plugin validate --strict claude-plugin   # the mod's manifest and hooks
claude plugin test claude-plugin                # every mod suite, on Claude's test kit
bunx tsc -p claude-plugin                       # hook types; see below
```

- `src/index.ts` is the factory. Its Capability contributes `claude-plugin/` as a Claude plugin folder and writes no file.
- `claude-plugin/.claude-plugin/marketplace.json` is the marketplace that Mate's wrap reuses to publish the folder to plain sessions, so Mate never writes into the installed package. Keep its one entry's name equal to `plugin.json`'s and its source `./`. Release preparation keeps `plugin.json`'s `version` at the release version.
- `claude-plugin/hooks/companion.ts` holds the pure logic: matching, rows, paths, secret rules, and reading Mate's `session context` reply.
- `claude-plugin/hooks/register.ts` holds the two hooks, `prompt.autocomplete` and `prompt.mention`.
- The hook suites in `claude-plugin/tests/` run on a fake disk, git and session from `tests/world.ts`, and need Claude's engine. The pure suite also runs under Bun, through the stand-in `claude-code/testing` module in `test/claude-code-testing.ts`.
- `test/rule-agreement.test.ts` holds the mod's secret matching to the same answers as mate-core's, checks the tests' policy fixture against what Mate sends, and reads what mate-core's session context query prints.

Claude writes the mod's types into `claude-plugin/.claude-plugin/types/` the first time a session loads it, for example `claude --plugin-dir claude-plugin`. `claude-plugin/tsconfig.json` extends them, so `tsc` works only after that. Git, the linter and the formatter ignore that folder, and the package leaves it out.

The mod API is early access in Claude Code and can change between releases. A stable release runs `bun run test` and `bun run test:hooks` before it starts, so the hook suites run against the Claude installed on the releasing machine; CI has no Claude and runs neither hook suite.
