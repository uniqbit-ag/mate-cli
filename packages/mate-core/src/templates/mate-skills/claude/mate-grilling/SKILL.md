---
name: mate-grilling
description: Relentlessly sharpen a plan through dependency-ordered design-tree rounds.
disable-model-invocation: true
---

# Mate Grilling

> Inspired by [Matt Pocock's grilling skill](https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling) and adapted here as a Mate process-driven skill.

Stress-test the current plan or idea as a design tree. This is a conversation,
not an implementation or documentation session: do not create or modify code,
context files, ADRs, OpenSpec artifacts, or other files.

## Rounds

Use this shape for each round:

```text
Q1 - <question title>: <question body, including choices when useful>
Recommended: <your recommended answer and its trade-off>
```

1. State the current design hypothesis and its intended outcome.
2. Expand the unresolved design tree: boundaries, actors, state, dependencies,
   failure paths, constraints, and acceptance evidence.
3. Order the frontier by dependency. Ask every question on the current frontier
   in one round, and present a recommended answer with the trade-off behind it.
4. Wait for explicit user answers. Never treat an unanswered recommendation as
   a decision.
5. Record the accepted decision in the next hypothesis, close resolved nodes,
   and continue with the next unblocked frontier.

Finding facts is the agent's job, not the user's. Use the available environment,
tools, or a sub-agent to resolve factual prerequisites instead of asking the user
for facts the agent can look up.

End when the frontier is empty and the user confirms shared understanding. If the
user names a blocker, stop and report the design as incomplete rather than
presenting it as settled. Return the decisions, unresolved questions, assumptions,
and a compact next-step summary.

## Guardrails

- Ask in rounds, not as a long questionnaire.
- Keep alternatives visible until the user chooses one.
- Challenge contradictions and missing failure behavior directly.
- Do not invoke another skill.
- Do not write files or persist the conversation.
