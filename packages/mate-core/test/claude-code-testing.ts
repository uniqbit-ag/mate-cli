/**
 * Stands in for Claude Code's `claude-code/testing` kit, so the mod's pure
 * suite runs under `bun test`. Only `describe`, `test` and `expect` exist
 * here: the hook suites need Claude's engine and run with `claude plugin test`.
 */
import { plugin } from "bun";
import { describe, expect, test } from "bun:test";

plugin({
  name: "claude-code-testing",
  setup(build) {
    build.module("claude-code/testing", () => ({
      exports: { describe, expect, test },
      loader: "object",
    }));
  },
});
