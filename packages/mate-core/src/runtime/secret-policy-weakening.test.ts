import { describe, expect, test } from "bun:test";

import { parseSecretsConfig } from "./secret-patterns";
import { secretPolicyWeakenings } from "./secret-policy-weakening";

const current = parseSecretsConfig({ deny: ["*.acmesecret"] });

describe("secretPolicyWeakenings", () => {
  test.each([
    ["guardrails off", { guardrails: false, deny: ["*.acmesecret"] }, ["guardrails turned off"]],
    [
      "allow added",
      { deny: ["*.acmesecret"], allow: ["*.acmesecret"] },
      ["allow pattern added: *.acmesecret"],
    ],
    ["deny removed", {}, ["deny pattern removed: *.acmesecret"]],
    ["deny added", { deny: ["*.acmesecret", "*.acmetoken"] }, []],
    ["equal", { deny: ["*.acmesecret"] }, []],
  ])("%s", (_name, next, expected) => {
    expect(secretPolicyWeakenings(current, parseSecretsConfig(next))).toEqual(expected);
  });
});
