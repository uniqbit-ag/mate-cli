---
name: mate-grill-me
description: Stress-test a plan or idea through dependency-ordered conversational design-tree rounds.
disable-model-invocation: true
metadata:
  credits:
    skill: grill-me
    author: Matt Pocock
    url: "https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md"
---

# Mate Grill Me

This skill runs before `/openspec-explore`. It stress-tests decisions; wide
repository investigation and option comparison belong to explore. When a
question would need mapping large parts of the repository, record it under
Unresolved or Assumptions in the handoff instead of investigating it.

Start `/mate-grilling`.

The session is conversational-only. It does not create or modify code, context
files, ADRs, OpenSpec artifacts, or other planning files.

## After grilling

When grilling returns, map its result into this block:

```text
PRE-EXPLORE HANDOFF (grill)
Confirmed:   <accepted decisions>
Unresolved:  <open questions, or "none">
Assumptions: <untested assumptions explore should verify, or "none">
Next: /openspec-explore
```

Confirmed decisions are settled; explore should not ask them again. Then tell
the user the next step is `/openspec-explore`; do not invoke it. The user starts
it in this conversation.

If grilling stopped on a blocker, still emit the block. List the blocker first
under Unresolved, keep only explicitly accepted decisions under Confirmed, and
do not present the design as settled.
