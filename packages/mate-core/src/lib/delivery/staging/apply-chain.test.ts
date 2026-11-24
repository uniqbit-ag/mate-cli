import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

import { describeFailure, failureRemedy } from "./apply-chain";

describe("failureRemedy", () => {
  test("quotes teammate names so the suggested command runs nothing they wrote", () => {
    const remedy = failureRemedy({
      kind: "stale",
      change: "acme-login",
      failure: {
        capability: "acme",
        requirement: "Foo $(touch pwned) `id` it's",
        versions: { base: "b", ours: "o", theirs: "t" },
      },
    });
    const command = remedy.split("run `mate ")[1]!.split("` (one triple")[0]!;
    // The shell sees each name as one literal word.
    const args = command.replace("<file>", "f");
    const words = spawnSync("sh", ["-c", `printf '%s\\n' ${args}`], { encoding: "utf8" }).stdout;
    expect(words.split("\n")).toContain("Foo $(touch pwned) `id` it's");
  });

  test("offers no command for a name that does not print as it is", () => {
    const remedy = failureRemedy({
      kind: "stale",
      change: "acme-login",
      failure: {
        capability: "acme",
        requirement: "Foo\u001b[2K",
        versions: { base: "b", ours: "o", theirs: "t" },
      },
    });
    expect(remedy).not.toContain("mate artifact resolve");
    expect(remedy).toContain("mate artifact submit");
  });
});

describe("describeFailure", () => {
  test("prints teammate names and details as one line without control characters", () => {
    const escape = "\u001b]0;acme\u0007\u001b[2K";
    const texts = [
      describeFailure(
        {
          kind: "stale",
          change: "acme-login",
          failure: { capability: `acme${escape}`, requirement: `Foo${escape}\nmate: done` },
        },
        "main",
      ),
      describeFailure(
        { kind: "apply", change: "acme-login", detail: `first${escape}\nsecond` },
        "main",
      ),
      describeFailure(
        { kind: "invalid", change: null, failure: { path: `a${escape}.md`, detail: `x\ny` } },
        "main",
      ),
    ];
    for (const text of texts) {
      // oxlint-disable-next-line no-control-regex -- control characters are what must be gone
      expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });
});
