import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkedGitKey,
  checkedGitToken,
  GIT_CREDENTIAL_FILE,
  GitCredentialStore,
  takeGitStartupToken,
} from "./git-credential-store";

const ACME = "https://git.acme.test/acme/web.git";

let dir: string | null = null;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function file(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-git-credential-"));
  return path.join(dir, GIT_CREDENTIAL_FILE);
}

describe("the Git credential store", () => {
  test("the organization's token beats the host's, which covers other organizations", () => {
    const store = new GitCredentialStore(file(), null);
    store.set("git.acme.test", "host-token");
    store.set("git.acme.test/acme", "org-token");
    expect(store.forUrl(ACME)).toBe("org-token");
    expect(store.forUrl("https://git.acme.test/other/api.git")).toBe("host-token");
    expect(store.forUrl("git.acme.test:acme/web.git")).toBeNull();
  });

  test("a token is used only for URLs its key matches", () => {
    const store = new GitCredentialStore(file(), null);
    store.set("git.acme.test", "host-token");
    expect(store.forUrl("https://git.example.test/acme/web.git")).toBeNull();
    store.set("git.example.test/acme", "org-token");
    expect(store.forUrl("https://git.example.test/other/web.git")).toBeNull();
  });

  test("keys and URLs compare without regard to case, and a nested group resolves to its first segment", () => {
    const store = new GitCredentialStore(file(), null);
    store.set(checkedGitKey("Git.Acme.Test/ACME"), "org-token");
    expect(store.forUrl("https://GIT.acme.test/Acme/web.git")).toBe("org-token");
    expect(store.forUrl("https://git.acme.test/acme/group/web.git")).toBe("org-token");
  });

  test("an SSH URL gets no token", () => {
    const store = new GitCredentialStore(file(), null);
    store.set("git.acme.test", "host-token");
    expect(store.forUrl("git@git.acme.test:acme/web.git")).toBeNull();
    expect(store.forUrl("ssh://git@git.acme.test/acme/web.git")).toBeNull();
  });

  test("a set token is written root-only, replaced by a second, and loaded again", () => {
    const target = file();
    const store = new GitCredentialStore(target, null);
    store.set("git.acme.test", "first");
    store.set("git.acme.test", "second");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir!)).toEqual([GIT_CREDENTIAL_FILE]);
    expect(new GitCredentialStore(target, null).forUrl(ACME)).toBe("second");
  });

  test("a stored token beats the startup token, which covers only its hosts", () => {
    const startup = { token: "startup-token", hosts: ["git.acme.test"] };
    const store = new GitCredentialStore(file(), startup);
    expect(store.forUrl(ACME)).toBe("startup-token");
    expect(store.forUrl("https://git.example.test/acme/web.git")).toBeNull();
    store.set("git.acme.test/acme", "org-token");
    expect(store.forUrl(ACME)).toBe("org-token");
  });

  test("status lists keys with their source and date, never a token", () => {
    const store = new GitCredentialStore(
      file(),
      { token: "startup-token", hosts: ["git.acme.test"] },
      () => new Date("2026-11-10T10:00:00Z"),
    );
    store.set("git.example.test/acme", "org-token");
    const status = store.status();
    expect(status).toEqual([
      { key: "git.acme.test", source: "startup", setAt: null },
      { key: "git.example.test/acme", source: "studio", setAt: "2026-11-10T10:00:00.000Z" },
    ]);
    expect(JSON.stringify(status)).not.toContain("token");
  });

  test("clearing a key falls back to the host, and a startup entry cannot be cleared away", () => {
    const store = new GitCredentialStore(file(), {
      token: "startup-token",
      hosts: ["git.acme.test"],
    });
    store.set("git.acme.test", "host-token");
    store.set("git.acme.test/acme", "org-token");
    store.clear("git.acme.test/acme");
    expect(store.forUrl(ACME)).toBe("host-token");
    store.clear("git.acme.test");
    store.clear("git.acme.test");
    expect(store.forUrl(ACME)).toBe("startup-token");
  });

  test("a store with no file refuses set and clear", () => {
    const store = new GitCredentialStore(null, null);
    expect(() => store.set("git.acme.test", "token")).toThrow(/no Git token file/);
    expect(() => store.clear("git.acme.test")).toThrow(/no Git token file/);
  });

  test("an unreadable file is an empty store", () => {
    const target = file();
    fs.writeFileSync(target, "{ nope");
    expect(new GitCredentialStore(target, null).status()).toEqual([]);
  });
});

describe("Git token checks", () => {
  test.each(["", "acme/web/extra", "git.acme.test/", "https://git.acme.test", "git acme", "-bad"])(
    "the key %j is refused",
    (key) => {
      expect(() => checkedGitKey(key)).toThrow(FactoryErrorPattern);
    },
  );

  test("a token with a space, a control character or too many characters is refused without quoting it", () => {
    for (const token of ["has space", "tab\there", `a${"b".repeat(1024)}`, ""]) {
      let message = "";
      try {
        checkedGitToken(token);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("has space");
      expect(message).not.toContain("tab\there");
    }
  });

  test("the startup token leaves the environment and needs a host to be usable", () => {
    const env: NodeJS.ProcessEnv = {
      MATE_GIT_CLONE_TOKEN: "startup-token",
      MATE_FACTORY_GIT_TOKEN_HOSTS: "Git.Acme.Test, git.example.test",
    };
    expect(takeGitStartupToken(env)).toEqual({
      token: "startup-token",
      hosts: ["git.acme.test", "git.example.test"],
    });
    expect(env).toEqual({});
    expect(takeGitStartupToken({ MATE_GIT_CLONE_TOKEN: "startup-token" })).toBeNull();
  });
});

const FactoryErrorPattern = /Git token|host/;
