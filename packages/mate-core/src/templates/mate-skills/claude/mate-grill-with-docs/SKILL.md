---
name: mate-grill-with-docs
description: Sharpen a design conversationally and record confirmed domain decisions on the Companion Repository artifact plane.
disable-model-invocation: true
---

# Mate Grill With Docs

> Inspired by [Matt Pocock's grill-with-docs skill](https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs) and adapted here as a Mate process-driven skill.

First invoke `/mate-grilling` and wait for explicit decisions. Then invoke
`/mate-domain-modeling` only for confirmed project terminology or durable
decisions.

The grilling phase remains dependency-ordered and conversational. Do not write
anything during it. The domain-modeling phase may write only after the user
authorizes a specific recording and only to the mapped Companion Repository
artifact path.

## Documentation boundary

- Put concise, project-specific definitions in the mapped context glossary.
- Do not put implementation details, task checklists, or speculative language
  in a glossary.
- Offer an ADR only when the decision is hard to reverse, surprising without
  context, and the result of a genuine trade-off.
- Skip ADRs for obvious or easily reversible choices.
- If repository or Area scope is ambiguous, stop and ask before modeling or
  recording anything.
