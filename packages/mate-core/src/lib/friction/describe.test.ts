import { expect, test } from "bun:test";

import { commandFingerprint, refusalFingerprint } from "../../runtime/friction-fingerprint";
import { describeFingerprint } from "./describe";

test("a refusal names its check and the kind of tool call", () => {
  expect(describeFingerprint(refusalFingerprint("artifact", "write"))).toBe(
    "The artifact check refused a file write",
  );
  expect(describeFingerprint(refusalFingerprint("secret", "read"))).toBe(
    "The secret check refused a file read",
  );
  expect(describeFingerprint(refusalFingerprint("attribution", "shell"))).toBe(
    "The attribution check refused a shell command",
  );
  expect(describeFingerprint(refusalFingerprint("fork", "search"))).toBe(
    "The fork check refused a search",
  );
  expect(describeFingerprint(refusalFingerprint("artifact", "other"))).toBe(
    "The artifact check refused a tool call",
  );
});

test("a failed command names the command and its exit code", () => {
  expect(
    describeFingerprint(
      commandFingerprint({
        command: "artifact",
        subcommand: "archive",
        flags: [],
        exitCode: 1,
        errorText: "",
      }),
    ),
  ).toBe("mate artifact archive failed with exit code 1");
});

test("an unknown fingerprint is returned unchanged", () => {
  for (const fingerprint of ["acme:unknown", "refusal:acme:write", "command:artifact:x"])
    expect(describeFingerprint(fingerprint)).toBe(fingerprint);
});
