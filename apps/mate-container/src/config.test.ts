import { describe, expect, test } from "bun:test";

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
    const config = resolveConfig({ MATE_AGENT_PORT: "9000" }, noFile);
    expect(config.agentPort).toBe(9000);
  });

  test("a setting is taken from the file when the environment does not supply it", () => {
    const config = resolveConfig({}, file({ agentPort: 9100 }));
    expect(config.agentPort).toBe(9100);
  });

  test("the environment outranks the file", () => {
    const config = resolveConfig({ MATE_AGENT_PORT: "9000" }, file({ agentPort: 9100 }));
    expect(config.agentPort).toBe(9000);
  });

  test("every documented setting resolves from its own environment variable", () => {
    const env: NodeJS.ProcessEnv = {
      MATE_COMPANIONS_DIR: "/srv/companions",
      MATE_COMPANION_REPOS: "https://example.com/acme.git",
      MATE_COMPANION: "acme",
      MATE_AGENT_PORT: "5001",
      MATE_AGENT_HOST: "127.0.0.1",
      MATE_STUDIO_PORT: "5002",
      MATE_STUDIO_HOST: "127.0.0.2",
      MATE_STUDIO_WRITABLE: "false",
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
      agentPort: 5001,
      agentHost: "127.0.0.1",
      studioPort: 5002,
      studioHost: "127.0.0.2",
      studioWritable: false,
      gitSync: true,
      gitUserName: "Appliance",
      gitUserEmail: "appliance@example.com",
      credentials: { ANTHROPIC_API_KEY: "secret" },
    });
  });

  test("every documented setting resolves from the file too", () => {
    const config = resolveConfig(
      {},
      file({
        companionsDir: "/srv/companions",
        companionRepos: ["https://example.com/acme.git"],
        companion: "acme",
        agentPort: 5001,
        agentHost: "127.0.0.1",
        studioPort: 5002,
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
    expect(config.gitSync).toBe(true);
    expect(config.credentials).toEqual({ ANTHROPIC_API_KEY: "secret" });
  });

  test("defaults apply where neither source supplies a value", () => {
    const config = resolveConfig({}, noFile);
    expect(config.companionsDir).toBe("/companions");
    expect(config.agentPort).toBe(4096);
    expect(config.agentHost).toBe("0.0.0.0");
    expect(config.studioPort).toBe(4097);
    expect(config.studioWritable).toBe(true);
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
    expect(() => resolveConfig({ MATE_AGENT_PORT: "http" }, noFile)).toThrow(ConfigError);
    try {
      resolveConfig({ MATE_AGENT_PORT: "http" }, noFile);
    } catch (error) {
      expect((error as ConfigError).setting).toBe("MATE_AGENT_PORT");
      expect((error as ConfigError).value).toBe("http");
      expect((error as ConfigError).message).toContain("MATE_AGENT_PORT");
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
