import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CREDENTIAL_FILE, checkedCredential, CredentialStore } from "./credential-store";

const TOKEN = "sk-ant-oat01-acme-token";
const KEY = "sk-ant-api03-acme-key";
const startup = { name: "ANTHROPIC_API_KEY" as const, value: "sk-ant-api03-acme-startup" };

let dir: string | null = null;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function file(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-credential-"));
  return path.join(dir, CREDENTIAL_FILE);
}

describe("the credential store", () => {
  test("a set credential is written root-only, used at once, and loaded again", () => {
    const target = file();
    const store = new CredentialStore(target, startup);
    store.set({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN });
    expect(store.current()).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir!)).toEqual([CREDENTIAL_FILE]);
    expect(new CredentialStore(target, null).current()?.value).toBe(TOKEN);
  });

  test("stored beats startup, and clear falls back to it", () => {
    const store = new CredentialStore(file(), startup);
    expect(store.status()).toEqual({ kind: "api-key", source: "startup", setAt: null });
    store.set({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN });
    expect(store.current()?.name).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(store.status()).toMatchObject({ kind: "subscription", source: "studio" });
    store.clear();
    expect(store.current()).toEqual(startup);
    expect(store.status().source).toBe("startup");
  });

  test("status never contains the value", () => {
    const store = new CredentialStore(file(), null);
    expect(store.status()).toEqual({ kind: null, source: null, setAt: null });
    store.set({ name: "ANTHROPIC_API_KEY", value: KEY });
    const status = store.status();
    expect(status.setAt).not.toBeNull();
    expect(JSON.stringify(status)).not.toContain("acme-key");
  });

  test("without a file nothing can be set or cleared", () => {
    const store = new CredentialStore(null, startup);
    expect(() => store.set(startup)).toThrow(/no credential file/);
    expect(() => store.clear()).toThrow(/no credential file/);
  });
});

describe("a credential's shape", () => {
  test("matches its kind's prefix", () => {
    expect(checkedCredential("api-key", ` ${KEY}\n`)).toEqual({
      name: "ANTHROPIC_API_KEY",
      value: KEY,
    });
    expect(checkedCredential("subscription", TOKEN).name).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test.each([
    ["api-key", TOKEN, /Anthropic API keys start with sk-ant-api/],
    ["subscription", "", /no Claude subscription token/],
    ["subscription", "sk-ant-oat01 acme", /start with sk-ant-oat and have no spaces/],
    ["password", KEY, /kind must be/],
  ])("%s %j is refused without quoting it", (kind, value, message) => {
    let error: Error | null = null;
    try {
      checkedCredential(kind, value);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toMatch(message);
    if (value) expect(error?.message).not.toContain(value);
  });
});
