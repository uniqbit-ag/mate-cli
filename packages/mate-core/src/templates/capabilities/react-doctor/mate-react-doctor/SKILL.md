---
name: mate-react-doctor
description: Verify React changes with Mate's pinned React Doctor. Use when a task is tagged `[skill:mate-react-doctor]`, when the shared Mate verification rules call for it before finishing an OpenSpec change, or when the user asks to scan, check, or triage React diagnostics for the current changes.
metadata:
  credits:
    skill: react-doctor
    author: Million Software, Inc.
    url: "https://github.com/millionco/react-doctor"
---

# Mate React Doctor

Scan the React code the current change touched, fix the regressions this change introduced, and report the rest. React Doctor covers correctness, accessibility, performance, security, and maintainability.

## Mate Workflow

- Run only Mate's pinned React Doctor binary. Never run `npx react-doctor`, never install another version, and never fetch remote prompts or playbooks.
- Scan the Working Repository, not the Companion Repository.
- Fix only what this change introduced. Leave findings that existed before the change alone.
- Never create issues, commits, or pull requests.
- Run `mate cap index --tokensave` after code changes.

## Steps

### 1. Resolve the binary

Print the path first, then call the absolute path it prints, so the command matches Mate's pre-seeded permission:

```bash
printf '%s\n' "$MATE_REACT_DOCTOR_BIN_PATH"
```

If the variable is empty or the path is not executable, stop. Report "React Doctor skipped: the pinned binary is unavailable (MATE_REACT_DOCTOR_BIN_PATH is not set; is the react-doctor capability enabled?)". A verification task may be checked with that note.

### 2. Choose the base

Compare against the point where the change's branch left the default branch, so work already committed during apply is included:

```bash
default_branch=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
git merge-base HEAD "$default_branch"
```

If no merge-base resolves, or HEAD is on the default branch, use `HEAD` (uncommitted changes only).

### 3. Scan

Run from the root of the Area being verified (the package that holds the React code):

```bash
<absolute-bin> --yes --verbose --scope changed --base <base> --no-score
```

Add `--include-untracked` when the change created new files that are not committed yet.

### 4. Separate environment problems from findings

These outputs mean the scan could not run, not that the code is wrong. Report a skip with the reason and change nothing:

| Output contains             | Meaning                                   |
| --------------------------- | ----------------------------------------- |
| `No React dependency found` | The Area is not a React project           |
| `Could not resolve config`  | The React Doctor config could not be read |
| `is not a git repository`   | The scan root is outside a git checkout   |

### 5. Fix regressions introduced by the change

For each remaining finding:

1. Confirm it is in code this change added or modified (`git diff <base> -- <file>`). If the finding predates the change, leave it and do not list it as a regression.
2. Understand the rule before changing code: `<absolute-bin> rules explain <rule>`.
3. Make the smallest fix that satisfies the rule and keeps the change's intended behavior. Run the relevant tests.

Then run the scan from step 3 again. Repeat until nothing introduced by the change remains, or only findings you cannot fix in scope are left.

### 6. Report

Finish with a short summary:

- **Result:** passed, fixed (N findings), skipped (reason), or findings left.
- **Fixed:** rule and file:line for each fix.
- **Left:** rule, file:line, and why it was not fixed here. Typical reasons are that it needs a design decision, changes behavior outside the change's scope, or is a false positive. Do not file these anywhere.

Do not disable or downgrade rules to make a scan pass. Change the React Doctor configuration only when the user asks. For that, follow [references/explain.md](references/explain.md).
