---
name: mate-archive-change
description: Deprecated alias that forwards to mate-submit-change, since changes are now submitted before the merge and archived at publication. Use when the user asks to archive a change.
allowed-tools: Bash(mate:*), Bash(git:*)
license: MIT
compatibility: Requires the mate CLI and the openspec capability enabled.
metadata:
  author: mate
  version: "2.0"
---

# Mate Archive Change

Deprecated: archiving before the merge is replaced by the Submit change stage, and
publication archives. Say so in one line, then follow
[../mate-submit-change/SKILL.md](../mate-submit-change/SKILL.md) for the same change, from
its first step. `mate artifact archive` is a deprecated alias that only checks and
submits nothing; never run it.
