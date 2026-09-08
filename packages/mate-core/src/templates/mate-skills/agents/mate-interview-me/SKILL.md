---
name: mate-interview-me
description: Clarify intent through a focused, one-question-at-a-time conversation before planning.
disable-model-invocation: true
---

# Mate Interview Me

> Inspired by [Addy Osmani's interview-me skill](https://github.com/addyosmani/agent-skills/tree/main/skills/interview-me) and adapted here as a Mate process-driven skill.

## Overview

What people ask for and what they actually want are different things. They ask
for a "dashboard" because that is what one asks for, not because a dashboard
solves their problem. They say "make it faster" without a number to hit.

The cheapest moment to find this gap is before any plan, spec, or code exists.
Once implementation has started, switching costs are real and the user may
rationalize the wrong thing into "good enough." This skill closes the gap before
it costs anything.

## When to Use

Apply this skill when:

- The ask is missing at least one of: who the user is, why they want it, what
  success looks like, or the binding constraint.
- The request is conventional rather than specific and cannot be unpacked
  without guessing.
- You are tempted to start with assumptions that have not been surfaced.
- The user has not said which value they are optimizing for when reasonable
  values are in tension, such as simplicity versus flexibility.
- The user explicitly invokes "interview me", "grill me", "are we sure?", or
  "stress-test my thinking".

**When NOT to use:**

- The ask is unambiguous and self-contained.
- The user explicitly asked for speed over verification.
- The request is purely informational.
- The operation is mechanical, such as a rename, format, or file move.
- You already have >=95% confidence; reread the stop condition before assuming
  you do not.

## Loading Constraints

This skill needs a live, responsive user. Do not use it in non-interactive
contexts such as CI pipelines, scheduled runs, loops, or autonomous runs. If an
underspecified ask arrives there, report the blocker instead of guessing.

## The Process

### Step 1: Hypothesize, with a confidence number

Before asking anything, write the current best read of what the user wants in one
sentence, followed by an honest confidence number from 0 to 100 percent. When
confidence is below 70 percent, state what is missing on the same line.

```text
HYPOTHESIS: You want <the underlying outcome>, and <the user's wording> was the convention that came to mind. CONFIDENCE: ~30% - missing: <what is unresolved>
```

The number forces honesty. If you wrote a high number but cannot predict the
user's reactions to the next three questions, the number is wrong.

### Step 2: Ask one question at a time, each with a guess attached

Ask exactly one focused question that would most reduce uncertainty. Attach your
best guess about the answer and the reasoning behind it:

```text
Q: <one focused question> GUESS: <your hypothesis for the answer and why>
```

Wait for the answer before asking the next question. Never batch questions or
advance silently. The guess exposes assumptions and lets the user correct them
quickly.

### Step 3: Listen for "want versus should want"

Watch for best-practice talk without specifics, deference to convention, phrases
such as "I should probably", and buzzwords used as goals instead of outcomes.
When you hear one, ask:

> _"If you did not have to justify this to anyone, what would you actually want?"_

### Step 4: Restate intent in the user's own words

When confidence is high, write back a concise restatement using the user's
language and these fields:

```text
Outcome:      <one line>
User:         <one line - who benefits>
Why now:      <one line - what changed>
Success:      <one line - how we know it worked>
Constraint:   <one line - the binding limit>
Out of scope: <one line - what we are explicitly not doing>
```

Ask: "Yes, no, or refine?" The out-of-scope line is mandatory; silent disagreement
about non-goals is a common source of misalignment.

### Step 5: Confirm explicitly

The gate is an explicit yes. These are not confirmation:

- "Whatever you think is best." Ask again with two concrete options.
- "Sounds good." Ask what the user would refine.
- "Sure, let us go." Check whether anything was missed.
- Silence followed by "okay, let us start." Ask whether the user has confirmed
  the restatement.

If the user corrects the restatement, fold in the correction and restate it again.

### The 95% Confidence Stop

Stop only when you can predict the user's reaction to the next three questions.
This is a checkable condition, not a feeling. If the user names a blocker before
that point, stop and label the result unresolved rather than calling it confirmed.

## Output

The deliverable is a confirmed statement of intent: the restatement above plus
an explicit yes. Specs, plans, and task lists are downstream and do not belong in
this skill. A blocked session returns its partial intent, blocker, and unresolved
questions instead.

## Mate Boundary

This is a conversational-only skill. Do not create or modify code, context files,
ADRs, OpenSpec artifacts, intent documents, or any other files. Do not claim that
a file was written, and do not invoke another skill.

## Verification

Before stopping, check that:

- An initial hypothesis and confidence number were stated.
- Every confidence number below 70 percent included its reason.
- Every question was asked one at a time with an attached guess.
- The want-versus-should-want probe ran when the user gave a convention or
  sophistication-signaling answer.
- The restatement includes Outcome, User, Why now, Success, Constraint, and Out
  of scope.
- The user explicitly confirmed the restatement, or the result is clearly marked
  unresolved because of a blocker.
