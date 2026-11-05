# Mate Revise Mode

Revises the planning artifacts a change already has, for example after a person reviewed
them, and keeps them consistent with each other. Not a Delivery Path stage.

1. **Name the change.** Use the change the user names; otherwise infer it from the
   conversation, or list the active changes and ask.

2. **Follow the OpenSpec workflow.** Read
   [openspec-update-change.md](openspec-update-change.md) and follow it. Propose the requested edit together with the matching edits to the other
   artifacts, and write each one only after the user confirms it. Ask for a ticket only when
   `mate artifact link "<name>" --json` reports `ticketFormat` `jira` and no
   `record.ticket`, as Step 3 of `SKILL.md` does.

3. **Upgrade a minimal change when it outgrows the gate.** When a revision makes a
   `mate-minimal` change fail a statement of the minimal gate (Step 1 of `SKILL.md`), or
   the user asks, name the failing statement and offer the upgrade to `mate-v1` once. Declined: continue
   the revision unchanged. Confirmed:

   1. Set `schema: mate-v1` in the change's `.openspec.yaml`, first, so `openspec
      instructions` returns the `mate-v1` text.
   2. Write the proposal from the existing specs and tasks, then the design, each from
      `openspec instructions <artifact-id> --change "<name>" --json` and each confirmed
      before writing.
   3. Align `tasks.md`: frontmatter `schema: mate-v1`, the `← [[proposal]] | [[design]]`
      line after the title, one heading per Area. Keep task numbers and check marks.
   4. Run `openspec validate "<name>" --strict` and `openspec status --change "<name>"`,
      and report any artifact still missing.

   This upgrade is the only case in which revise mode creates a missing artifact. Never
   downgrade a `mate-v1` change; suggest a new change instead.

4. **Hand off.**
   End the response with a final `## Next steps` section: numbered required actions in
   execution order, with exact commands and known change names, prerequisites first.
   Summaries, evidence, warnings, optional work, and deferred context go above it; nothing
   follows it. Listing an action never invokes it.
   Swap skill prefixes per **Skill invocation** in `SKILL.md`.
   Start with reviewing the revised artifacts. When the change already has checked
   tasks, then list `/mate-apply-change <change-name>` to carry the revision into code;
   when every task is checked, `/mate-archive-change <change-name>`.

Guardrails:

- Planning artifacts only; never edit product code.
- Reviews are done by people. Never describe a revision or a passing validation as
  approval.
