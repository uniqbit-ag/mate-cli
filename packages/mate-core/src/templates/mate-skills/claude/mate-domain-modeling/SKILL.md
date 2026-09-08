---
name: mate-domain-modeling
description: Build a project domain model using Mate context-map scope and Companion Repository artifacts.
disable-model-invocation: true
---

# Mate Domain Modeling

> Inspired by [Matt Pocock's domain-modeling skill](https://github.com/mattpocock/skills/tree/main/skills/engineering/domain-modeling) and adapted here as a Mate process-driven skill.

Actively sharpen project terminology and durable domain decisions. Reading a
context for vocabulary is not enough: challenge fuzzy terms, test boundaries
with concrete scenarios, and ask the user to confirm each proposed definition
or decision.

## Resolve scope first

1. Identify the Companion Repository that owns the session and read its root
   `CONTEXT-MAP.md` before any domain analysis. This is the companion-wide index
   for shared contexts and repository-scoped context maps.
2. Resolve the primary Working Repository from its canonical Git remote or the
   explicit Mate repository attachment. Do not use a checkout basename as its
   identity.
3. Convert the canonical external repository ID to its filesystem key only for
   path lookup. For example, `acme/repo` maps to `acme_repo`. Keep the canonical
   ID authoritative, and use the same normalized key everywhere; do not guess
   from a checkout name or silently accept a colliding key.
4. Read the repository-scoped map at
   `repos/<normalized-repository-id>/CONTEXT-MAP.md`, when present. Resolve the
   repository-relative Area from that map. In a monorepo, the Area is the owning
   package root such as `packages/acme`; in a non-monorepo it is the exact
   repository-relative path, such as `docs` or `.`.
5. Select exactly one context-map entry matching the canonical repository ID
   and Area, then load only its mapped context file. Never apply another
   repository's context. Shared context is applicable only when the root map
   explicitly maps it to the current scope.

If the topic cannot be mapped to exactly one repository and Area, ask the user
to identify the scope. Do not guess, synthesize an Area, use `N/A`, or fall back
to a checkout name.

## Model the domain

- Call out terms that conflict with the mapped glossary.
- Propose one canonical term when language is vague or overloaded, listing
  meaningful alternatives as avoided terms.
- Use concrete and edge-case scenarios to test relationships and boundaries.
- Compare claims about behavior with the relevant Working Repository code.
- Keep context entries to project-specific definitions, not implementation
  details.

## Companion-plane writes

When the user confirms a term or authorizes a durable decision, write the mapped
context or ADR artifact under the Companion Repository artifact root. Repository-
specific artifacts belong below
`repos/<normalized-repository-id>/` and shared artifacts belong at the
companion-wide location named by the root map. Never write directly to the
Working Repository or a reference repository. Create directories lazily,
preserve unrelated content, and report the exact companion artifact path
changed. Update the mapped context inline as each term is confirmed rather than
batching changes; create a missing repository map, context, or ADR file only
when it is first needed.

Use the ADR only when all three conditions hold: the choice is hard to reverse,
surprising without context, and the result of a genuine trade-off. A reversible or
obvious choice does not receive an ADR. See the bundled references for the
compact context and ADR formats.
