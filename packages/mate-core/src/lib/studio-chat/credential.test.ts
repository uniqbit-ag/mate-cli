import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chatCredentialFile, createChatCredentials } from "./credential";

const KEY = "sk-ant-api03-acme";
const TOKEN = "sk-ant-oat01-acme";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mate-chat-credential-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const credentials = (env: NodeJS.ProcessEnv = {}, appliance = false) =>
  createChatCredentials({ file: chatCredentialFile(home), env, appliance });

describe("the chat credential", () => {
  test("one set in Studio wins over the environment, survives a new store, and clears back", () => {
    const env = { ANTHROPIC_API_KEY: KEY };
    const store = credentials(env);
    store.set({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN });
    expect(store.auth()).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN });
    expect(credentials(env).status()).toMatchObject({ kind: "subscription", source: "studio" });
    store.clear();
    expect(store.status()).toEqual({ kind: "api-key", source: "startup", setAt: null });
  });

  test("is kept user-only under Mate's home and leaves the environment in place", () => {
    const env = { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
    credentials(env).set({ name: "ANTHROPIC_API_KEY", value: KEY });
    const file = chatCredentialFile(home);
    expect(file).toBe(path.join(home, "studio-chat", "credential.env"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(env).toEqual({ ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  });

  test("the environment's API key comes before its subscription token", () => {
    const store = credentials({ ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, true);
    expect(store.auth()).toEqual({ name: "ANTHROPIC_API_KEY", value: KEY });
  });

  test("a standard Studio with nothing set lets the harness find the login", () => {
    expect(credentials().auth()).toBe("login");
    expect(credentials().status()).toEqual({ kind: null, source: "login", setAt: null });
  });

  test("a standard Studio answers on the environment's credential its status names", () => {
    const store = credentials({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(store.auth()).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN });
    expect(store.status()).toEqual({ kind: "subscription", source: "startup", setAt: null });
  });

  test("the appliance hands over the environment's API key, and with none has no credential", () => {
    expect(credentials({ ANTHROPIC_API_KEY: KEY }, true).auth()).toEqual({
      name: "ANTHROPIC_API_KEY",
      value: KEY,
    });
    // A subscription token never answers in the appliance.
    expect(credentials({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, true).auth()).toBeNull();
    expect(credentials({}, true).auth()).toBeNull();
    expect(credentials({}, true).status()).toEqual({ kind: null, source: null, setAt: null });
  });

  test("the appliance refuses a subscription token and removes one set before", () => {
    expect(() =>
      credentials({}, true).set({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN }),
    ).toThrow("the appliance takes an Anthropic API key only; nothing was stored");
    expect(fs.existsSync(chatCredentialFile(home))).toBe(false);

    credentials().set({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN });
    expect(credentials({}, true).auth()).toBeNull();
    expect(fs.existsSync(chatCredentialFile(home))).toBe(false);
    expect(credentials({}, true).status()).toEqual({ kind: null, source: null, setAt: null });
    // A key set in Studio stays.
    credentials().set({ name: "ANTHROPIC_API_KEY", value: KEY });
    expect(credentials({}, true).status()).toMatchObject({ kind: "api-key", source: "studio" });
    credentials().clear();
    const withKey = credentials({ ANTHROPIC_API_KEY: KEY }, true);
    expect(withKey.auth()).toEqual({ name: "ANTHROPIC_API_KEY", value: KEY });
    expect(withKey.status()).toEqual({ kind: "api-key", source: "startup", setAt: null });
    withKey.set({ name: "ANTHROPIC_API_KEY", value: KEY });
    expect(withKey.status()).toMatchObject({ kind: "api-key", source: "studio" });
  });
});
