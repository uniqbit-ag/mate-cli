---
name: mate-simplify-code
description: Simplifies code for clarity. Use when refactoring code for clarity without changing behavior. Use when code works but is harder to read, maintain, or extend than it should be. Use when reviewing code that has accumulated unnecessary complexity.
disable-model-invocation: true
---

# Mate Simplify Code

> Inspired by [Addy Osmani's code-simplification skill](https://github.com/addyosmani/agent-skills/tree/main/skills/code-simplification) and adapted here as a Mate process-driven skill.

## Overview

Simplify code by reducing complexity while preserving exact behavior. The goal is not fewer lines — it's code that is easier to read, understand, modify, and debug. Every simplification must pass a simple test: "Would a new team member understand this faster than the original?"

## Mate Workflow

- Inspect the requested scope and its callers, callees, and tests before editing. Use the available code-graph tools before broad source scans.
- Keep the refactor limited to the requested scope; do not make unrelated cleanup changes.
- Run the relevant tests after each simplification. Do not modify tests merely to make a refactor pass.
- Format touched files with the project's own formatter — detect it first (see Principle 2); never run a formatter the project has not adopted.
- Run `mate cap index --tokensave` after code changes.
- Never commit, push, or create a pull request unless the user explicitly asks.

## When to Use

- After a feature is working and tests pass, but the implementation feels heavier than it needs to be
- During code review when readability or complexity issues are flagged
- When you encounter deeply nested logic, long functions, or unclear names
- When refactoring code written under time pressure
- When consolidating related logic scattered across files
- After merging changes that introduced duplication or inconsistency

**When NOT to use:**

- Code is already clean and readable — don't simplify for the sake of it
- You don't understand what the code does yet — comprehend before you simplify
- The code is performance-critical and the "simpler" version would be measurably slower
- You're about to rewrite the module entirely — simplifying throwaway code wastes effort

## The Five Principles

### 1. Preserve Behavior Exactly

Don't change what the code does — only how it expresses it. All inputs, outputs, side effects, error behavior, and edge cases must remain identical. If you're not sure a simplification preserves behavior, don't make it.

```
ASK BEFORE EVERY CHANGE:
→ Does this produce the same output for every input?
→ Does this maintain the same error behavior?
→ Does this preserve the same side effects and ordering?
→ Do all existing tests still pass without modification?
```

### 2. Follow Project Conventions

Simplification means making code more consistent with the codebase, not imposing external preferences. Before simplifying:

```
1. Read CLAUDE.md / project conventions
2. Study how neighboring code handles similar patterns
3. Match the project's style for:
   - Import ordering and module system
   - Function declaration style
   - Naming conventions
   - Error handling patterns
   - Type annotation depth
```

Simplification that breaks project consistency is not simplification — it's churn.

**Formatting is a project convention, not yours.** Never reach for a formatter by habit. Reformatting with a tool the project has not adopted rewrites lines you never touched and buries the refactor in noise.

Detect the formatter before formatting anything — first match wins:

| Signal in the repo                                                                | Formatter to run                                                                 |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `format` / `fmt` script in `package.json`, `Makefile`, `justfile`, `Taskfile.yml` | Run that script — it encodes the project's intent and needs no further detection |
| `biome.json` / `biome.jsonc`                                                      | `biome format --write`                                                           |
| `.oxfmtrc.json`, or `oxfmt` in devDependencies                                    | `oxfmt`                                                                          |
| `dprint.json` / `.dprint.jsonc`                                                   | `dprint fmt`                                                                     |
| `.prettierrc*`, `prettier.config.*`, or a `prettier` key in `package.json`        | `prettier --write`                                                               |
| `rustfmt.toml`, or any Cargo crate                                                | `cargo fmt`                                                                      |
| `[tool.ruff]` in `pyproject.toml`                                                 | `ruff format`                                                                    |
| `[tool.black]` in `pyproject.toml`                                                | `black`                                                                          |
| Go module                                                                         | `gofmt -w` (or `goimports -w` if already used)                                   |
| Only `.editorconfig`, or no signal at all                                         | Do not format — match the surrounding style by hand                              |

Rules:

- Invoke the project's pinned local binary through its package manager or runner, inferred from the lockfile (`bun`, `pnpm`, `yarn`, `npm`) — never a global install and never an `npx`-downloaded version, which may differ from the one that formatted the committed code.
- If several formatters are configured, the `format` script decides. If there is no script and the signals conflict, ask which is canonical instead of picking one.
- Format only the files you changed. A repo-wide format pass is a separate change with its own diff.
- If the formatter rewrites far more than the lines you touched, its config disagrees with the committed code. Stop, revert the formatting, and report it — do not fold that drift into a simplification change.

### 3. Prefer Clarity Over Cleverness

Explicit code is better than compact code when the compact version requires a mental pause to parse.

```typescript
// UNCLEAR: Dense ternary chain
const label = isNew ? "New" : isUpdated ? "Updated" : isArchived ? "Archived" : "Active";

// CLEAR: Readable mapping
function getStatusLabel(item: Item): string {
  if (item.isNew) return "New";
  if (item.isUpdated) return "Updated";
  if (item.isArchived) return "Archived";
  return "Active";
}
```

```typescript
// UNCLEAR: Chained reduces with inline logic
const result = items.reduce(
  (acc, item) => ({
    ...acc,
    [item.id]: { ...acc[item.id], count: (acc[item.id]?.count ?? 0) + 1 },
  }),
  {},
);

// CLEAR: Named intermediate step
const countById = new Map<string, number>();
for (const item of items) {
  countById.set(item.id, (countById.get(item.id) ?? 0) + 1);
}
```

### 4. Maintain Balance

Simplification has a failure mode: over-simplification. Watch for these traps:

- **Inlining too aggressively** — removing a helper that gave a concept a name makes the call site harder to read
- **Combining unrelated logic** — two simple functions merged into one complex function is not simpler
- **Removing "unnecessary" abstraction** — some abstractions exist for extensibility or testability, not complexity
- **Optimizing for line count** — fewer lines is not the goal; easier comprehension is

### 5. Scope to What Changed

Default to simplifying recently modified code. Avoid drive-by refactors of unrelated code unless explicitly asked to broaden scope. Unscoped simplification creates noise in diffs and risks unintended regressions.

## The Simplification Process

### Step 1: Understand Before Touching (Chesterton's Fence)

Before changing or removing anything, understand why it exists. This is Chesterton's Fence: if you see a fence across a road and don't understand why it's there, don't tear it down. First understand the reason, then decide if the reason still applies.

```
BEFORE SIMPLIFYING, ANSWER:
- What is this code's responsibility?
- What calls it? What does it call?
- What are the edge cases and error paths?
- Are there tests that define the expected behavior?
- Why might it have been written this way? (Performance? Platform constraint? Historical reason?)
- Check git blame: what was the original context for this code?
```

If you can't answer these, you're not ready to simplify. Read more context first.

### Step 2: Identify Simplification Opportunities

#### Step 2a: Mechanical pre-scan (required)

Run the scan before reading source. Its output **is** the candidate list — a pattern
nobody looked for is a pattern nobody finds, and prose tables alone are read with a
bias toward "this file looks fine".

```
PRE-SCAN THE REQUESTED SCOPE:
1. Code graph, if available — tokensave_module_api (export surface vs. real
   consumers), tokensave_dead_code, tokensave_similar (near-duplicate bodies),
   tokensave_complexity / tokensave_largest (nesting, long functions)
2. Unused-export detector, if the project already has one configured
   (knip, ts-prune, eslint import-x/no-unused-modules, Python vulture)
3. Grep for consumers when neither is available — including test files,
   and including the bare symbol name, not just import statements
```

Do not skip the pre-scan because the file "looks clean". Judgment applies to the
candidates it produces, not to whether to produce them. Report candidates you
deliberately leave alone, with the reason.

**A pre-scan hit is a question, not a verdict.** These tools find symbols nothing
_imports_; they cannot see symbols resolved by name — framework exports, reflective
lookups, config-referenced files. Every "unused export" candidate must clear the
**Behavior-preservation rules for the module surface** below before you touch it.
Read that section before acting on this list, not after.

Then scan for these patterns — each one is a concrete signal, not a vague smell:

**Structural complexity:**

| Pattern                    | Signal                             | Simplification                                            |
| -------------------------- | ---------------------------------- | --------------------------------------------------------- |
| Deep nesting (3+ levels)   | Hard to follow control flow        | Extract conditions into guard clauses or helper functions |
| Long functions (50+ lines) | Multiple responsibilities          | Split into focused functions with descriptive names       |
| Nested ternaries           | Requires mental stack to parse     | Replace with if/else chains, switch, or lookup objects    |
| Boolean parameter flags    | `doThing(true, false, true)`       | Replace with options objects or separate functions        |
| Repeated conditionals      | Same `if` check in multiple places | Extract to a well-named predicate function                |

**Naming and readability:**

| Pattern                    | Signal                                         | Simplification                                                           |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| Generic names              | `data`, `result`, `temp`, `val`, `item`        | Rename to describe the content: `userProfile`, `validationErrors`        |
| Abbreviated names          | `usr`, `cfg`, `btn`, `evt`                     | Use full words unless the abbreviation is universal (`id`, `url`, `api`) |
| Misleading names           | Function named `get` that also mutates state   | Rename to reflect actual behavior                                        |
| Comments explaining "what" | `// increment counter` above `count++`         | Delete the comment — the code is clear enough                            |
| Comments explaining "why"  | `// Retry because the API is flaky under load` | Keep these — they carry intent the code can't express                    |

**Redundancy:**

| Pattern                   | Signal                                                       | Simplification                                            |
| ------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| Duplicated logic          | Same 5+ lines in multiple places                             | Extract to a shared function                              |
| Dead code                 | Unreachable branches, unused variables, commented-out blocks | Remove (after confirming it's truly dead)                 |
| Unnecessary abstractions  | Wrapper that adds no value                                   | Inline the wrapper, call the underlying function directly |
| Over-engineered patterns  | Factory-for-a-factory, strategy-with-one-strategy            | Replace with the simple direct approach                   |
| Redundant type assertions | Casting to a type that's already inferred                    | Remove the assertion                                      |

**Module surface:**

A module's public API should match what is actually consumed. Surface bloat is
invisible inside a single file — it only shows up when you compare exports against
callers, which is what the Step 2a pre-scan does.

| Pattern                       | Signal                                                           | Simplification                                                      |
| ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Over-exported module          | Export has no consumer outside its own file                      | Drop `export` — keep the symbol, narrow its visibility              |
| Leaked intermediate types     | Type exported only to annotate a private helper or internal step | Unexport — but only if it appears in no exported signature          |
| Speculative public API        | Export added "for later" with no caller                          | Unexport first; delete only per the dead-code rule above            |
| Single-consumer bag-of-things | Many exports, exactly one importer                               | **Propose only** — API reshape, not a visibility change (see below) |
| Re-export passthrough         | Barrel file that only forwards a single symbol                   | **Propose only** — changes module resolution repo-wide (see below)  |

Narrowing visibility is not inlining — the named helper survives, so this does not
conflict with the over-simplification traps in Principle 4. Only inline a helper when
the name itself carries no meaning at the call site.

#### Behavior-preservation rules for the module surface

Principle 1 governs this table without exception. Visibility is not behavior — until
something resolves the symbol by name rather than by import. Then it is.

**Unexport, don't delete.** In a type-checked project, removing `export` is verified by
the compiler: any importer becomes a compile error, so a mistake fails loudly and
immediately. Deleting the symbol has no such net. Narrow visibility as its own step;
treat deletion as a separate decision under the dead-code rule, not as part of the
same edit.

**That safety net requires a type checker that actually runs over the file.** Plain
JavaScript, TypeScript with `checkJs` off, or a project with no `tsc --noEmit` gate
gets no compile error — a broken import fails at runtime instead, possibly only on one
code path. In an unchecked project, do not unexport on pre-scan evidence alone: confirm
each consumer by grep first, or leave the export and report it.

**A test is a consumer.** If the only importer is a test file, the export is load-
bearing — unexporting it breaks the test, and Principle 1 forbids editing tests to make
a refactor pass. Leave it exported. "No production consumer" is not "no consumer";
report it as a possible test-only seam instead of acting on it.

**A type used in an exported signature stays exported.** If an exported function takes
or returns the type, consumers need to name it — unexporting breaks call sites and
declaration emit even though nothing imports the type directly today. Only unexport a
type that appears exclusively in module-private positions.

**Never touch an export the framework resolves by name.** These have no importer
anywhere by design, so "no consumer found" is meaningless for them — the pre-scan and
every unused-export detector will report them as dead, and they are not:

```
FRAMEWORK-RESOLVED — OUT OF SCOPE, DO NOT UNEXPORT OR RENAME:
- Next.js app router: default, metadata, generateMetadata, generateStaticParams,
  revalidate, dynamic, runtime, viewport, route handlers (GET/POST/...),
  middleware, error/loading/not-found boundaries
- Next.js pages router: default, getServerSideProps, getStaticProps, getStaticPaths
- Test and story files: Storybook CSF (default + named story exports), fixtures,
  setup files referenced by config rather than imported
- Package entry points: anything reachable from package.json exports/main/types,
  or from a documented public API
- Config-referenced modules: paths named in tsconfig, bundler, or tool config
- Reflective resolution: dynamic import() with a computed specifier, glob imports
  (import.meta.glob, require.context), DI containers, decorators, plugin registries
```

**Propose-only rows are not yours to apply.** Collapsing a multi-export module to one
entry point, or deleting a barrel, is an API reshape: it rewrites call sites in files
outside the requested scope, changes module resolution for deep importers, and is a
design decision rather than a behavior-preserving edit. Both collide with Principle 5.
Describe the change and the affected files, then stop and let the user decide — the
same treatment the prop-drilling case gets under React guidance.

**When the pre-scan flags a symbol you cannot prove is unreferenced, leave it and say
so.** An export you were unsure about and kept costs a line of explanation. An export
you removed on a guess costs a production incident. Unverifiable candidates are
reported, not acted on.

```
BEFORE REMOVING ANY export, ALL MUST HOLD:
[ ] Not framework-resolved (checked against the list above)
[ ] Not reachable from a package entry point or documented API
[ ] No importer anywhere — including tests, stories, and config
[ ] If a type: appears in no exported signature
[ ] A type checker covers this file and will run before the change is accepted
[ ] The symbol name greps clean outside its own file
Any box unchecked → report the candidate, do not touch it.
```

### Step 3: Apply Changes Incrementally

Make one simplification at a time. Run tests after each change. **Submit refactoring changes separately from feature or bug fix changes.** A PR that refactors and adds a feature is two PRs — split them.

```
FOR EACH SIMPLIFICATION:
1. Make the change
2. Run the type checker / compiler, then the test suite
   (visibility changes surface as compile errors, not test failures — a green
    test run alone does not prove an unexport was safe)
3. If both pass → continue to the next simplification; commit only if the user explicitly asks
4. If either fails → revert and reconsider
```

Avoid batching multiple simplifications into a single untested change. If something breaks, you need to know which simplification caused it.

**The Rule of 500:** If a refactoring would touch more than 500 lines, invest in automation (codemods or AST transforms) rather than making the changes by hand. Manual edits at that scale are error-prone and exhausting to review.

### Step 4: Verify the Result

Run the project's formatter (detected in Principle 2) over the files you touched, then re-run the type checker and test suite — formatting must never be the last unverified step.

Then step back and evaluate the whole:

```
COMPARE BEFORE AND AFTER:
- Is the simplified version genuinely easier to understand?
- Did you introduce any new patterns inconsistent with the codebase?
- Is the diff clean and reviewable?
- Would a teammate approve this change?
```

If the "simplified" version is harder to understand or review, revert. Not every simplification attempt succeeds.

## Language-Specific Guidance

### TypeScript / JavaScript

```typescript
// SIMPLIFY: Unnecessary async wrapper
// Before
async function getUser(id: string): Promise<User> {
  return await userService.findById(id);
}
// After
function getUser(id: string): Promise<User> {
  return userService.findById(id);
}

// SIMPLIFY: Verbose conditional assignment
// Before
let displayName: string;
if (user.nickname) {
  displayName = user.nickname;
} else {
  displayName = user.fullName;
}
// After
const displayName = user.nickname || user.fullName;

// SIMPLIFY: Manual array building
// Before
const activeUsers: User[] = [];
for (const user of users) {
  if (user.isActive) {
    activeUsers.push(user);
  }
}
// After
const activeUsers = users.filter((user) => user.isActive);

// SIMPLIFY: Redundant boolean return
// Before
function isValid(input: string): boolean {
  if (input.length > 0 && input.length < 100) {
    return true;
  }
  return false;
}
// After
function isValid(input: string): boolean {
  return input.length > 0 && input.length < 100;
}
```

### Python

```python
# SIMPLIFY: Verbose dictionary building
# Before
result = {}
for item in items:
    result[item.id] = item.name
# After
result = {item.id: item.name for item in items}

# SIMPLIFY: Nested conditionals with early return
# Before
def process(data):
    if data is not None:
        if data.is_valid():
            if data.has_permission():
                return do_work(data)
            else:
                raise PermissionError("No permission")
        else:
            raise ValueError("Invalid data")
    else:
        raise TypeError("Data is None")
# After
def process(data):
    if data is None:
        raise TypeError("Data is None")
    if not data.is_valid():
        raise ValueError("Invalid data")
    if not data.has_permission():
        raise PermissionError("No permission")
    return do_work(data)
```

### React / JSX

```tsx
// SIMPLIFY: Verbose conditional rendering
// Before
function UserBadge({ user }: Props) {
  if (user.isAdmin) {
    return <Badge variant="admin">Admin</Badge>;
  } else {
    return <Badge variant="default">User</Badge>;
  }
}
// After
function UserBadge({ user }: Props) {
  const variant = user.isAdmin ? "admin" : "default";
  const label = user.isAdmin ? "Admin" : "User";
  return <Badge variant={variant}>{label}</Badge>;
}

// SIMPLIFY: Prop drilling through intermediate components
// Before — consider whether context or composition solves this better.
// This is a judgment call — flag it, don't auto-refactor.
```

## Common Rationalizations

| Rationalization                                      | Reality                                                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| "It's working, no need to touch it"                  | Working code that's hard to read will be hard to fix when it breaks. Simplifying now saves time on every future change.                               |
| "Fewer lines is always simpler"                      | A 1-line nested ternary is not simpler than a 5-line if/else. Simplicity is about comprehension speed, not line count.                                |
| "I'll just quickly simplify this unrelated code too" | Unscoped simplification creates noisy diffs and risks regressions in code you didn't intend to change. Stay focused.                                  |
| "The types make it self-documenting"                 | Types document structure, not intent. A well-named function explains _why_ better than a type signature explains _what_.                              |
| "This abstraction might be useful later"             | Don't preserve speculative abstractions. If it's not used now, it's complexity without value. Remove it and re-add when needed.                       |
| "The original author must have had a reason"         | Maybe. Check git blame — apply Chesterton's Fence. But accumulated complexity often has no reason; it's just the residue of iteration under pressure. |
| "I'll refactor while adding this feature"            | Separate refactoring from feature work. Mixed changes are harder to review, revert, and understand in history.                                        |

## Red Flags

- Simplification that requires modifying tests to pass (you likely changed behavior)
- "Simplified" code that is longer and harder to follow than the original
- Renaming things to match your preferences rather than project conventions
- Removing error handling because "it makes the code cleaner"
- Simplifying code you don't fully understand
- Batching many simplifications into one large, hard-to-review commit
- Refactoring code outside the scope of the current task without being asked
- Deleting an export because a tool reported it unused, without checking whether the
  framework resolves it by name (`page.tsx`, `route.ts`, stories, config-referenced files)
- Acting on a pre-scan candidate you could not verify — report it instead
- Treating a green test run as proof a visibility change was safe without a type check
- Unexporting a symbol whose only importer is a test, then editing the test to match
- Applying a propose-only row (module collapse, barrel deletion) without user sign-off
- Trusting "the compiler would catch it" in a project the type checker does not cover

## Verification

After completing a simplification pass:

- [ ] All existing tests pass without modification
- [ ] Build succeeds with no new warnings
- [ ] The project's own formatter was detected and run on the touched files — no formatter the project has not adopted was used
- [ ] Formatting touched only the changed files (no repo-wide reformat mixed in)
- [ ] Linter passes (no style regressions)
- [ ] Each simplification is a reviewable, incremental change
- [ ] The diff is clean — no unrelated changes mixed in
- [ ] Simplified code follows project conventions (checked against CLAUDE.md or equivalent)
- [ ] No error handling was removed or weakened
- [ ] No dead code was left behind (unused imports, unreachable branches)
- [ ] The Step 2a pre-scan was run, and every candidate is either fixed or explained
- [ ] Export surface matches actual consumers — nothing exported without a caller outside its file
- [ ] Type checker passes — no unexport broke an importer
- [ ] No framework-resolved export was unexported, renamed, or deleted
- [ ] Every removed `export` cleared all boxes of the pre-removal checklist
- [ ] No test was edited to accommodate a visibility change
- [ ] Propose-only findings were reported, not applied
- [ ] Behavior is bit-for-bit identical: same inputs, outputs, side effects, error paths
- [ ] A teammate or review agent would approve the change as a net improvement
