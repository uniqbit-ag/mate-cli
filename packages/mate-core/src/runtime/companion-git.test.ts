import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  companionGit,
  isAuthenticationFailure,
  REMOTE_URLS_QUERY,
  shouldRetryWithoutSsh,
  sshRewriteArgs,
  toSshUrl,
  type GitResult,
} from "./companion-git";
import {
  makeSshStub,
  shellQuoted,
  stubHttpsUrl,
  stubSshUrl,
  writeSshStub,
  type SshStub,
} from "../../../../test/ssh-stub";

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

interface Harness {
  root: string;
  bare: string;
  work: string;
  httpsUrl: string;
  sshUrl: string;
  env: SshStub["env"];
  sshCalls: () => string[];
}

function makeHarness(): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-companion-git-")));
  tempRoots.push(root);
  const bare = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "config", "user.email", "test@example.test");
  git(seed, "config", "user.name", "Test");
  fs.writeFileSync(path.join(seed, "notes.md"), "initial\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "initial");
  git(seed, "push", "-q", bare, "main");
  git(root, "clone", "-q", bare, work);
  git(work, "config", "user.email", "test@example.test");
  git(work, "config", "user.name", "Test");
  const httpsUrl = stubHttpsUrl(bare);
  git(work, "remote", "set-url", "origin", httpsUrl);
  const stub = makeSshStub(root);
  return {
    root,
    bare,
    work,
    httpsUrl,
    sshUrl: stubSshUrl(bare),
    env: stub.env,
    sshCalls: stub.calls,
  };
}

function advanceRemote(h: Harness, content: string): void {
  const other = path.join(h.root, `other-${Math.random().toString(36).slice(2)}`);
  git(h.root, "clone", "-q", h.bare, other);
  git(other, "config", "user.email", "test@example.test");
  git(other, "config", "user.name", "Test");
  fs.writeFileSync(path.join(other, "notes.md"), content);
  git(other, "commit", "-qam", content.trim());
  git(other, "push", "-q", "origin", "main");
}

const noTerminal = { isTerminal: () => false };
const terminal = { isTerminal: () => true };

describe("companionGit transport", () => {
  test("fetches over SSH first and leaves the stored URL unchanged", async () => {
    const h = makeHarness();
    advanceRemote(h, "remote\n");

    const result = await companionGit(
      h.work,
      { prompt: "never", env: h.env("ok") },
      noTerminal,
    ).fetch(["origin"]);

    expect(result.status).toBe(0);
    expect(result.transport).toBe("ssh");
    expect(h.sshCalls()).toHaveLength(1);
    expect(h.sshCalls()[0]).toContain("git@example.test");
    expect(git(h.work, "rev-parse", "origin/main").stdout).toBe(
      git(h.bare, "rev-parse", "main").stdout,
    );
    expect(git(h.work, "remote", "get-url", "origin").stdout.trim()).toBe(h.httpsUrl);
  });

  test("falls back to the configured HTTP(S) URL when SSH is unavailable", async () => {
    const h = makeHarness();
    advanceRemote(h, "remote\n");

    const result = await companionGit(
      h.work,
      { prompt: "never", env: h.env("refused") },
      noTerminal,
    ).fetch(["origin"]);

    expect(result.status).toBe(0);
    expect(result.transport).toBe("http");
    expect(h.sshCalls()).toHaveLength(1);
  });

  test("does not fall back when the remote rejects a push", async () => {
    const h = makeHarness();
    advanceRemote(h, "remote\n");
    fs.writeFileSync(path.join(h.work, "notes.md"), "local\n");
    git(h.work, "commit", "-qam", "local");
    /** Without the HTTP(S) rewrite a fallback would fail to resolve the host instead. */
    const env = { ...h.env("ok"), GIT_CONFIG_COUNT: "0" };

    const result = await companionGit(h.work, { prompt: "never", env }, noTerminal).push([
      "origin",
      "main",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.transport).toBe("ssh");
    expect(result.stderr).toContain("[rejected]");
    expect(result.stderr).not.toContain("resolve host");
  });

  test("uses an SSH remote as configured", async () => {
    const h = makeHarness();
    git(h.work, "remote", "set-url", "origin", h.sshUrl);

    const result = await companionGit(
      h.work,
      { prompt: "never", env: h.env("ok") },
      noTerminal,
    ).fetch(["origin"]);

    expect(result.status).toBe(0);
    expect(result.transport).toBe("ssh");
    expect(h.sshCalls()).toHaveLength(1);
  });

  test("clones an HTTP(S) URL over SSH first, then falls back without a partial checkout", async () => {
    const h = makeHarness();

    const viaSsh = await companionGit(
      h.root,
      { prompt: "never", env: h.env("ok") },
      noTerminal,
    ).clone(h.httpsUrl, "over-ssh");
    expect(viaSsh.status).toBe(0);
    expect(viaSsh.transport).toBe("ssh");
    expect(git(path.join(h.root, "over-ssh"), "remote", "get-url", "origin").stdout.trim()).toBe(
      h.httpsUrl,
    );

    const fallback = await companionGit(
      h.root,
      { prompt: "never", env: h.env("refused") },
      noTerminal,
    ).clone(h.httpsUrl, "fallback", { branch: "main" });
    expect(fallback.status).toBe(0);
    expect(fallback.transport).toBe("http");
    expect(fs.readFileSync(path.join(h.root, "fallback", "notes.md"), "utf8")).toBe("initial\n");
    expect(h.sshCalls()).toHaveLength(2);
  });
});

describe("companionGit prompt policy", () => {
  test("never: a passphrase-protected key fails promptly as an authentication failure", async () => {
    const h = makeHarness();
    git(h.work, "remote", "set-url", "origin", h.sshUrl);
    const started = Date.now();

    const result = await companionGit(
      h.work,
      { prompt: "never", env: h.env("passphrase") },
      noTerminal,
    ).fetch(["origin"]);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.status).not.toBe(0);
    expect(isAuthenticationFailure(result)).toBe(true);
    expect(h.sshCalls()[0]).toContain("BatchMode=yes");
  });

  test("never: an unknown host key is not confirmed", async () => {
    const h = makeHarness();
    git(h.work, "remote", "set-url", "origin", h.sshUrl);
    const started = Date.now();

    const result = await companionGit(
      h.work,
      { prompt: "never", env: h.env("hostkey") },
      noTerminal,
    ).fetch(["origin"]);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Host key verification failed");
  });

  test("never: Git runs with terminal prompts disabled", async () => {
    const h = makeHarness();
    const marker = path.join(h.root, "prompt-mode");
    const askpass = path.join(h.root, "askpass");
    fs.writeFileSync(askpass, `#!/bin/sh\nprintf '%s' "$GIT_TERMINAL_PROMPT" > ${marker}\n`, {
      mode: 0o755,
    });
    const env = h.env("ok", { GIT_SSH_COMMAND: `${shellQuoted(askpass)}`, GIT_SSH_VARIANT: "ssh" });

    await companionGit(h.work, { prompt: "never", env }, noTerminal).fetch(["origin"]);

    expect(fs.readFileSync(marker, "utf8")).toBe("0");
  });

  test("if-terminal without a terminal behaves as never", async () => {
    const h = makeHarness();

    await companionGit(h.work, { prompt: "if-terminal", env: h.env("ok") }, noTerminal).fetch([
      "origin",
    ]);

    expect(h.sshCalls()[0]).toContain("BatchMode=yes");
  });

  test("if-terminal at a terminal leaves SSH free to prompt", async () => {
    const h = makeHarness();

    await companionGit(h.work, { prompt: "if-terminal", env: h.env("ok") }, terminal).fetch([
      "origin",
    ]);

    expect(h.sshCalls()[0]).not.toContain("BatchMode=yes");
  });

  test("never: keeps a GIT_SSH_COMMAND with spaces and appends BatchMode", async () => {
    const h = makeHarness();
    const spaced = writeSshStub(path.join(h.root, "dir with space"));
    const env = h.env("ok", { GIT_SSH_COMMAND: `${shellQuoted(spaced)} -o ConnectTimeout=5` });

    const result = await companionGit(h.work, { prompt: "never", env }, noTerminal).fetch([
      "origin",
    ]);

    expect(result.status).toBe(0);
    expect(h.sshCalls()[0]).toContain("ConnectTimeout=5");
    expect(h.sshCalls()[0]).toContain("BatchMode=yes");
  });

  test("never: GIT_SSH_COMMAND built from a repository core.sshCommand keeps that command", async () => {
    const h = makeHarness();
    const configured = writeSshStub(path.join(h.root, "configured"));
    git(h.work, "config", "core.sshCommand", shellQuoted(configured));
    const { GIT_SSH_COMMAND: _unset, ...env } = h.env("ok");

    const result = await companionGit(h.work, { prompt: "never", env }, noTerminal).fetch([
      "origin",
    ]);

    expect(result.status).toBe(0);
    expect(h.sshCalls()).toHaveLength(1);
    expect(h.sshCalls()[0]).toContain("BatchMode=yes");
  });
});

describe("companionGit time bound", () => {
  test("ends a slow SSH attempt when the operation's bound is spent", async () => {
    const h = makeHarness();
    const started = Date.now();

    const result = await companionGit(
      h.work,
      { prompt: "never", budgetMs: 700, env: h.env("slow") },
      noTerminal,
    ).fetch(["origin"]);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.status).not.toBe(0);
    expect(result.timedOut).toBe(true);
  });

  test("starts no command once the bound is spent", async () => {
    const h = makeHarness();
    const operation = companionGit(h.work, { prompt: "never", budgetMs: 1 }, noTerminal);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await operation.run(["rev-parse", "HEAD"]);

    expect(result.status).not.toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("");
  });

  test("caps each local command within the budget", async () => {
    const h = makeHarness();
    const started = Date.now();

    const result = await companionGit(
      h.work,
      { prompt: "never", budgetMs: 20_000, commandCapMs: 300 },
      noTerminal,
    ).run(["-c", "alias.slow=!sleep 30", "slow"]);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
  });
});

describe("companionGit runner", () => {
  test("captures output beyond 1 MiB", async () => {
    const h = makeHarness();
    fs.writeFileSync(path.join(h.work, "big.txt"), "x".repeat(2 * 1024 * 1024));
    git(h.work, "add", "big.txt");
    git(h.work, "commit", "-qm", "big");

    const result = await companionGit(h.work, { prompt: "never" }, noTerminal).run([
      "show",
      "HEAD:big.txt",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(1024 * 1024);
  });
});

describe("companionGit steps", () => {
  test("upstreamTarget prefers @{u}, then origin/HEAD, then origin/main", async () => {
    const h = makeHarness();
    const operation = () => companionGit(h.work, { prompt: "never" }, noTerminal);
    expect(await operation().upstreamTarget()).toEqual({
      remote: "origin",
      branch: "main",
      ref: "origin/main",
    });

    git(h.work, "branch", "--unset-upstream");
    git(h.work, "remote", "set-head", "origin", "main");
    expect((await operation().upstreamTarget())?.ref).toBe("origin/main");

    git(h.work, "remote", "set-head", "origin", "--delete");
    expect((await operation().upstreamTarget())?.ref).toBe("origin/main");

    git(h.work, "update-ref", "-d", "refs/remotes/origin/main");
    expect(await operation().upstreamTarget()).toBeNull();
  });

  test("forkState counts ahead and behind against the resolved target", async () => {
    const h = makeHarness();
    advanceRemote(h, "remote\n");
    await companionGit(h.work, { prompt: "never", env: h.env("ok") }, noTerminal).fetch(["origin"]);
    fs.writeFileSync(path.join(h.work, "local.md"), "local\n");
    git(h.work, "add", "local.md");
    git(h.work, "commit", "-qm", "local");

    const fork = await companionGit(h.work, { prompt: "never" }, noTerminal).forkState();

    expect(fork).toEqual({ ahead: 1, behind: 1, forked: true });
  });

  test("forkState is null without a resolvable target", async () => {
    const h = makeHarness();
    git(h.work, "branch", "--unset-upstream");
    git(h.work, "update-ref", "-d", "refs/remotes/origin/main");
    git(h.work, "remote", "set-head", "origin", "--delete");

    expect(await companionGit(h.work, { prompt: "never" }, noTerminal).forkState()).toBeNull();
  });
});
