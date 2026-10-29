---
name: mate-clarify-intent
description: Pick the pre-explore mode a request needs (interview, grilling, or skip) from what it already states, then run that one mode. Use only when the user explicitly starts clarifying an idea before exploring a change.
disable-model-invocation: true
license: MIT
compatibility: Requires the mate CLI and the openspec capability enabled.
metadata:
  author: mate
  version: "1.0"
---

# Mate Clarify Intent

The optional first stage of the Delivery Path. It runs before `/mate-explore-change`
and decides how much clarification a request needs: an interview when intent is
incomplete, grilling when intent is clear but a proposed direction needs testing, or
nothing at all for a small, fully specified change.

Read only the user's request and this conversation. Do not read or investigate the
repository; questions that need repository evidence go to explore.

## Step 1: Fill the slot table

Mark each slot `stated`, `implied`, or `missing` from the request and conversation:

| Slot       | Question                                      |
| ---------- | --------------------------------------------- |
| Who        | Who benefits or is affected?                  |
| Why        | What problem or change makes this needed now? |
| Success    | How will we know it worked?                   |
| Constraint | What limit binds the solution?                |

`implied` Success counts as `missing`: a guessed success measure is the gap this stage
exists to close. Then note whether the request proposes a direction (an approach,
design, or solution shape): yes or no.

## Step 2: Route

Apply the first rule that matches:

1. Any slot `missing` → **interview**.
2. All slots filled and a direction is proposed → **grill**.
3. All slots filled, no direction, and the change is minimal-eligible (one Area, low
   risk, no new dependency or data-model change) → **skip**.
4. Otherwise → **grill**.

## Step 3: Announce and accept an override

Show the slot table with each slot's mark, the direction answer, and the route with
its rule in one line, for example:

```text
Route: interview — Success is missing.
Reply `interview`, `grill`, or `skip` to switch; anything else continues.
```

A one-word reply `interview`, `grill`, or `skip` replaces the route without further
questions. Run exactly one mode.

## Step 4: Run the routed mode

Run the mode by **reading its instructions and following them**, not by invoking a
skill. Resolve the file relative to this skill's own directory:

- **interview** → read `../mate-interview-me/SKILL.md` and follow it from its first
  step.
- **grill** → read `../mate-grill-me/SKILL.md` and follow it.
- **skip** → run nothing.

`mate-interview-me` and `mate-grill-me` are manual-only skills: never call them through
the skill mechanism. Reading the file is the supported way to run them from here. If
the file is missing, report that the companion's Mate skills need
`mate companion update` and stop.

## Step 5: Hand off

A routed mode ends with its own `PRE-EXPLORE HANDOFF` block naming
`/mate-explore-change`. For **skip**, emit:

```text
PRE-EXPLORE HANDOFF (skip)
Confirmed:   <the four slots as stated>
Unresolved:  none
Assumptions: <points explore should verify, or "none">
Next: /mate-explore-change
```

Tell the user the next step is `/mate-explore-change`; do not invoke it.

## Mate Boundary

Conversational only. Do not create or modify code, context files, ADRs, OpenSpec
artifacts, or any other file. This skill runs before `/mate-explore-change`: wide
repository investigation and option comparison belong there, recorded under
Unresolved or Assumptions in the handoff.
