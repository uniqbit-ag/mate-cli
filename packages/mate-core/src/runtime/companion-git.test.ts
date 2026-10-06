import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  REMOTE_URLS_QUERY,
  runPreferringSsh,
  shouldRetryWithoutSsh,
  sshRewriteArgs,
  toSshUrl,
  type GitResult,
} from "./companion-git";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

describe("toSshUrl", () => {
  test("maps HTTPS to scp-style SSH", () => {
    expect(toSshUrl("https://github.com/acme/acme-companion.git")).toBe(
      "git@github.com:acme/acme-companion.git",
    );
  });

  test("keeps an explicit port with the ssh:// form", () => {
    expect(toSshUrl("https://git.example.test:8443/acme/acme.git")).toBe(
      "ssh://git@git.example.test:8443/acme/acme.git",
    );
  });

  test("drops embedded credentials", () => {
    expect(toSshUrl("https://user:token@git.example.test/acme/acme.git")).toBe(
      "git@git.example.test:acme/acme.git",
    );
  });

  test("leaves SSH, file, and local paths alone", () => {
    expect(toSshUrl("git@github.com:acme/acme.git")).toBeNull();
    expect(toSshUrl("ssh://git@git.example.test:22222/acme/acme.git")).toBeNull();
    expect(toSshUrl("file:///tmp/acme.git")).toBeNull();
    expect(toSshUrl("/tmp/acme.git")).toBeNull();
  });
});

describe("sshRewriteArgs", () => {
  test("rewrites only HTTP(S) remotes, once per URL", () => {
    const output = [
      "remote.origin.url https://github.com/acme/acme.git",
      "remote.origin.pushurl https://github.com/acme/acme.git",
      "remote.mirror.url git@github.com:acme/mirror.git",
    ].join("\n");

    expect(sshRewriteArgs(output)).toEqual([
      "-c",
      "url.git@github.com:acme/acme.git.insteadOf=https://github.com/acme/acme.git",
    ]);
  });

  test("is empty without HTTP(S) remotes", () => {
    expect(sshRewriteArgs("")).toEqual([]);
    expect(sshRewriteArgs("remote.origin.url git@github.com:acme/acme.git")).toEqual([]);
  });

  test("makes Git resolve a configured HTTPS remote to SSH", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-ssh-rewrite-"));
    tempRoots.push(root);
    git(root, "init", "-q");
    git(root, "remote", "add", "origin", "https://github.com/acme/acme.git");

    const rewrite = sshRewriteArgs(git(root, ...REMOTE_URLS_QUERY).stdout);
    const resolved = git(root, ...rewrite, "ls-remote", "--get-url", "origin");

    expect(resolved.stdout.trim()).toBe("git@github.com:acme/acme.git");
    expect(git(root, "remote", "get-url", "origin").stdout.trim()).toBe(
      "https://github.com/acme/acme.git",
    );
  });
});

describe("shouldRetryWithoutSsh", () => {
  test("retries transport failures but not remote rejections", () => {
    expect(shouldRetryWithoutSsh({ status: 0, stdout: "", stderr: "" })).toBe(false);
    expect(
      shouldRetryWithoutSsh({ status: 128, stdout: "", stderr: "Permission denied (publickey)." }),
    ).toBe(true);
    expect(
      shouldRetryWithoutSsh({
        status: 1,
        stdout: "",
        stderr: " ! [rejected]        main -> main (non-fast-forward)",
      }),
    ).toBe(false);
    expect(
      shouldRetryWithoutSsh({
        status: 1,
        stdout: "",
        stderr: " ! [remote rejected] main -> main (protected branch)",
      }),
    ).toBe(false);
  });
});

describe("runPreferringSsh", () => {
  const httpsRemote = "remote.origin.url https://github.com/acme/acme.git\n";

  function recorder(results: (args: readonly string[]) => GitResult) {
    const calls: string[][] = [];
    const run = (args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "config" ? { status: 0, stdout: httpsRemote, stderr: "" } : results(args);
    };
    return { calls, run };
  }

  test("stops after a successful SSH attempt", () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "", stderr: "" }));

    runPreferringSsh(run, ["fetch", "origin"], (result) => result);

    expect(calls.slice(1)).toEqual([
      [
        "-c",
        "url.git@github.com:acme/acme.git.insteadOf=https://github.com/acme/acme.git",
        "fetch",
        "origin",
      ],
    ]);
  });

  test("falls back to the configured URL when SSH fails", () => {
    const { calls, run } = recorder((args) =>
      args[0] === "-c"
        ? { status: 128, stdout: "", stderr: "Permission denied (publickey)." }
        : { status: 0, stdout: "", stderr: "" },
    );

    const result = runPreferringSsh(run, ["fetch", "origin"], (r) => r);

    expect(result.status).toBe(0);
    expect(calls.at(-1)).toEqual(["fetch", "origin"]);
  });

  test("runs once, unchanged, for SSH remotes", () => {
    const calls: string[][] = [];
    runPreferringSsh(
      (args) => {
        calls.push([...args]);
        return args[0] === "config"
          ? { status: 0, stdout: "remote.origin.url git@github.com:acme/acme.git\n", stderr: "" }
          : { status: 0, stdout: "", stderr: "" };
      },
      ["push", "--follow-tags"],
      (r) => r,
    );

    expect(calls.slice(1)).toEqual([["push", "--follow-tags"]]);
  });
});
