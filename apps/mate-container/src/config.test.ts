import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  ConfigError,
  CONFIG_FILE_ENV,
  DEFAULT_CONFIG_FILE,
  directoryForUrl,
  readConfigFile,
  resolveConfig,
  SETTINGS,
} from "./config";

const noFile = () => ({});
const file = (values: Record<string, unknown>) => () => values;

describe("every setting is readable from both sources", () => {
  test("a setting is taken from the environment", () => {
    const config = resolveConfig({ MATE_STUDIO_PORT: "9000" }, noFile);
    expect(config.studioPort).toBe(9000);
  });

  test("a setting is taken from the file when the environment does not supply it", () => {
    const config = resolveConfig({}, file({ studioPort: 9100 }));
    expect(config.studioPort).toBe(9100);
  });

  test("the environment outranks the file", () => {
    const config = resolveConfig({ MATE_STUDIO_PORT: "9000" }, file({ studioPort: 9100 }));
    expect(config.studioPort).toBe(9000);
  });

  test("every documented setting resolves from its own environment variable", () => {
    const env: NodeJS.ProcessEnv = {
      MATE_COMPANIONS_DIR: "/srv/companions",
      MATE_COMPANION_REPOS: "https://example.com/acme.git",
      MATE_COMPANION: "acme",
      MATE_STUDIO_PORT: "5002",
      MATE_STUDIO_HOST: "127.0.0.2",
      MATE_STUDIO_WRITABLE: "true",
      MATE_STUDIO_TERMINAL: "false",
      MATE_STUDIO_DETACH_MINUTES: "45",
      MATE_STUDIO_TOKEN: "s".repeat(40),
      MATE_STUDIO_ALLOWED_HOSTS: "studio.acme.test, localhost:8080",
      MATE_STUDIO_PUBLIC_ORIGIN: "https://studio.acme.test",
      MATE_GIT_SYNC: "true",
      MATE_GIT_USER_NAME: "Appliance",
      MATE_GIT_USER_EMAIL: "appliance@example.com",
      MATE_AGENT_CREDENTIALS: "ANTHROPIC_API_KEY=secret",
    };
    const config = resolveConfig(env, noFile);
    expect(config).toEqual({
      companionsDir: "/srv/companions",
      companionRepos: [{ url: "https://example.com/acme.git", directory: "acme" }],
      companion: "acme",
      studioPort: 5002,
      studioHost: "127.0.0.2",
      studioWritable: true,
      studioTerminal: false,
      studioDetachMinutes: 45,
      studioToken: "s".repeat(40),
      studioAllowedHosts: ["studio.acme.test", "localhost:8080"],
      studioPublicOrigin: "https://studio.acme.test",
      gitSync: true,
      gitUserName: "Appliance",
      gitUserEmail: "appliance@example.com",
      credentials: { ANTHROPIC_API_KEY: "secret" },
      removed: [],
    });
  });

  test("every documented setting resolves from the file too", () => {
    const config = resolveConfig(
      {},
      file({
        companionsDir: "/srv/companions",
        companionRepos: ["https://example.com/acme.git"],
        companion: "acme",
        studioPort: 5002,
        studioTerminal: true,
        studioDetachMinutes: 10,
        studioAllowedHosts: ["studio.acme.test"],
        studioPublicOrigin: "https://studio.acme.test",
        studioHost: "127.0.0.2",
        studioWritable: false,
        gitSync: true,
        gitUserName: "Appliance",
        gitUserEmail: "appliance@example.com",
        credentials: { ANTHROPIC_API_KEY: "secret" },
      }),
    );
    expect(config.companionsDir).toBe("/srv/companions");
    expect(config.companionRepos).toEqual([
      { url: "https://example.com/acme.git", directory: "acme" },
    ]);
    expect(config.studioWritable).toBe(false);
    expect(config.studioTerminal).toBe(false);
    expect(config.studioDetachMinutes).toBe(10);
    expect(config.studioAllowedHosts).toEqual(["studio.acme.test"]);
    expect(config.studioPublicOrigin).toBe("https://studio.acme.test");
    expect(config.gitSync).toBe(true);
    expect(config.credentials).toEqual({ ANTHROPIC_API_KEY: "secret" });
  });

  test("defaults apply where neither source supplies a value", () => {
    const config = resolveConfig({}, noFile);
    expect(config.companionsDir).toBe("/companions");
    expect(config.studioPort).toBe(4097);
    expect(config.studioWritable).toBe(true);
    expect(config.studioTerminal).toBe(true);
    expect(config.studioDetachMinutes).toBe(30);
    expect(config.studioToken).toBeNull();
    expect(config.studioAllowedHosts).toEqual([]);
    expect(config.studioPublicOrigin).toBeNull();
    expect(config.removed).toEqual([]);
    expect(config.gitSync).toBe(false);
    expect(config.companionRepos).toEqual([]);
    expect(config.credentials).toEqual({});
  });

  test("the configuration file location is itself a setting", () => {
    expect(SETTINGS.map((setting) => setting.env)).toContain(CONFIG_FILE_ENV);
    expect(readConfigFile("/nonexistent/appliance.yaml")).toEqual({});
    expect(DEFAULT_CONFIG_FILE).toBe("/etc/mate/appliance.yaml");
  });
});

describe("an unusable value stops startup rather than defaulting", () => {
  test("a port that is not a number is reported with its setting and value", () => {
    expect(() => resolveConfig({ MATE_STUDIO_PORT: "http" }, noFile)).toThrow(ConfigError);
    try {
      resolveConfig({ MATE_STUDIO_PORT: "http" }, noFile);
    } catch (error) {
      expect((error as ConfigError).setting).toBe("MATE_STUDIO_PORT");
      expect((error as ConfigError).value).toBe("http");
      expect((error as ConfigError).message).toContain("MATE_STUDIO_PORT");
      expect((error as ConfigError).message).toContain("http");
    }
  });

  test("a port outside the range is reported rather than clamped", () => {
    for (const value of ["0", "65536", "99999"]) {
      expect(() => resolveConfig({ MATE_STUDIO_PORT: value }, noFile)).toThrow(ConfigError);
    }
  });

  test("an unusable boolean is reported", () => {
    expect(() => resolveConfig({ MATE_STUDIO_WRITABLE: "maybe" }, noFile)).toThrow(ConfigError);
  });

  test("a Git location with no URL is reported", () => {
    expect(() => resolveConfig({}, file({ companionRepos: [{ directory: "acme" }] }))).toThrow(
      ConfigError,
    );
  });

  test("a destination that escapes the companions directory is reported", () => {
    expect(() =>
      resolveConfig({ MATE_COMPANION_REPOS: "https://example.com/acme.git=../elsewhere" }, noFile),
    ).toThrow(ConfigError);
  });
});

describe("Git locations", () => {
  test("a destination defaults to the repository name", () => {
    expect(directoryForUrl("https://example.com/org/acme.git")).toBe("acme");
    expect(directoryForUrl("git@example.com:org/acme.git")).toBe("acme");
    expect(directoryForUrl("https://example.com/org/acme/")).toBe("acme");
  });

  test("several locations are accepted on one line and one per line", () => {
    const commas = resolveConfig(
      { MATE_COMPANION_REPOS: "https://example.com/a.git,https://example.com/b.git" },
      noFile,
    );
    const lines = resolveConfig(
      { MATE_COMPANION_REPOS: "https://example.com/a.git\nhttps://example.com/b.git" },
      noFile,
    );
    expect(commas.companionRepos.map((location) => location.directory)).toEqual(["a", "b"]);
    expect(lines.companionRepos).toEqual(commas.companionRepos);
  });

  test("a destination can be named explicitly", () => {
    const config = resolveConfig(
      { MATE_COMPANION_REPOS: "https://example.com/a.git=acme" },
      noFile,
    );
    expect(config.companionRepos).toEqual([
      { url: "https://example.com/a.git", directory: "acme" },
    ]);
  });
});

describe("credentials", () => {
  test("a mapping in the file is read as supplied", () => {
    const config = resolveConfig({}, file({ credentials: { A: "1", B: "2" } }));
    expect(config.credentials).toEqual({ A: "1", B: "2" });
  });

  test("NAME=value pairs in the environment are read one per line", () => {
    const config = resolveConfig({ MATE_AGENT_CREDENTIALS: "A=1\nB=2\n# a comment" }, noFile);
    expect(config.credentials).toEqual({ A: "1", B: "2" });
  });

  test("a value containing an equals sign is kept whole", () => {
    const config = resolveConfig({ MATE_AGENT_CREDENTIALS: "TOKEN=a=b=c" }, noFile);
    expect(config.credentials.TOKEN).toBe("a=b=c");
  });
});

describe("the terminal settings", () => {
  test("turning the write path off turns the terminal off", () => {
    expect(resolveConfig({ MATE_STUDIO_WRITABLE: "false" }, noFile).studioTerminal).toBe(false);
    expect(
      resolveConfig({ MATE_STUDIO_WRITABLE: "false", MATE_STUDIO_TERMINAL: "true" }, noFile)
        .studioTerminal,
    ).toBe(false);
  });

  test.each([
    { env: { MATE_STUDIO_DETACH_MINUTES: "0" }, setting: "MATE_STUDIO_DETACH_MINUTES" },
    { env: { MATE_STUDIO_DETACH_MINUTES: "1.5" }, setting: "MATE_STUDIO_DETACH_MINUTES" },
    {
      env: { MATE_STUDIO_PUBLIC_ORIGIN: "studio.acme.test" },
      setting: "MATE_STUDIO_PUBLIC_ORIGIN",
    },
    {
      env: { MATE_STUDIO_PUBLIC_ORIGIN: "https://studio.acme.test/app" },
      setting: "MATE_STUDIO_PUBLIC_ORIGIN",
    },
    { env: { MATE_STUDIO_ALLOWED_HOSTS: "acme.test/x" }, setting: "MATE_STUDIO_ALLOWED_HOSTS" },
    { env: { MATE_STUDIO_TERMINAL: "maybe" }, setting: "MATE_STUDIO_TERMINAL" },
  ])("refuses $env", ({ env, setting }) => {
    try {
      resolveConfig(env, noFile);
      throw new Error("expected a ConfigError");
    } catch (error) {
      expect((error as ConfigError).setting).toBe(setting);
    }
  });

  test("a short token is refused without echoing it", () => {
    try {
      resolveConfig({ MATE_STUDIO_TOKEN: "tooshort-secret" }, noFile);
      throw new Error("expected a ConfigError");
    } catch (error) {
      expect((error as ConfigError).setting).toBe("MATE_STUDIO_TOKEN");
      expect((error as ConfigError).message).not.toContain("tooshort-secret");
    }
  });

  test("the removed agent settings are named, not refused", () => {
    expect(
      resolveConfig({ MATE_AGENT_PORT: "4096" }, file({ agentHost: "0.0.0.0" })).removed,
    ).toEqual(["MATE_AGENT_PORT", "MATE_AGENT_HOST"]);
    expect(SETTINGS.map((setting) => setting.env)).not.toContain("MATE_AGENT_PORT");
  });
});

describe("the documented settings", () => {
  const page = fs.readFileSync(
    path.join(
      import.meta.dir,
      "..",
      "..",
      "docs",
      "content",
      "docs",
      "reference",
      "deployment.mdx",
    ),
    "utf8",
  );
  const documented = [...page.matchAll(/^\| `(MATE_[A-Z_]+)`/gm)].map((match) => match[1]);

  test("the deployment table lists exactly the settings the container has", () => {
    expect(documented.toSorted()).toEqual(SETTINGS.map((setting) => setting.env).toSorted());
  });
});
