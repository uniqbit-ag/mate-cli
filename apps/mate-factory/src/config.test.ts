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
  repositoryOfUrl,
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
      MATE_AUDIENCE: "ba",
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
      MATE_PLUGIN_REGISTRY: "@acme=https://registry.acme.test/api/npm",
      MATE_PLUGIN_REGISTRY_TOKEN: "reg-token",
      MATE_GIT_CLONE_TOKEN: "git-token",
      MATE_SETUP_HINT: "Run setup.",
      MATE_FACTORY: "true",
      CLAUDE_CODE_OAUTH_TOKEN: "acme-token",
      MATE_FACTORY_REPOSITORIES: "https://git.acme.test/acme/web.git",
      MATE_FACTORY_MAX_RUNS: "3",
      MATE_FACTORY_STAGE_MINUTES: "45",
      MATE_FACTORY_GIT_NAME: "acme-mate-bot",
      MATE_FACTORY_GIT_EMAIL: "mate-bot@acme.test",
    };
    const config = resolveConfig(env, noFile);
    expect(config).toEqual({
      companionsDir: "/srv/companions",
      companionRepos: [{ url: "https://example.com/acme.git", directory: "acme" }],
      companion: "acme",
      audience: "ba",
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
      pluginRegistry: {
        scope: "@acme",
        url: "https://registry.acme.test/api/npm/",
        token: "reg-token",
      },
      gitCloneToken: "git-token",
      setupHint: "Run setup.",
      removed: [],
      factory: {
        enabled: true,
        credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "acme-token" },
        repositories: ["https://git.acme.test/acme/web.git"],
        maxRuns: 3,
        stageMinutes: 45,
        gitName: "acme-mate-bot",
        gitEmail: "mate-bot@acme.test",
      },
    });
  });

  test("every documented setting resolves from the file too", () => {
    const config = resolveConfig(
      {},
      file({
        companionsDir: "/srv/companions",
        companionRepos: ["https://example.com/acme.git"],
        companion: "acme",
        audience: "ba",
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
    expect(config.audience).toBe("ba");
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
    expect(config.audience).toBeNull();
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

describe("the plugin registry", () => {
  const registry = "@acme=https://registry.acme.test/api/npm/";

  test("absent leaves startup setup disabled", () => {
    expect(resolveConfig({}, noFile).pluginRegistry).toBeNull();
    expect(resolveConfig({ MATE_PLUGIN_REGISTRY_TOKEN: "t" }, noFile).pluginRegistry).toBeNull();
  });

  test("a scope, URL and token enable it, from either source with environment precedence", () => {
    expect(
      resolveConfig({ MATE_PLUGIN_REGISTRY: registry, MATE_PLUGIN_REGISTRY_TOKEN: "t" }, noFile)
        .pluginRegistry,
    ).toEqual({ scope: "@acme", url: "https://registry.acme.test/api/npm/", token: "t" });
    const fromFile = file({
      pluginRegistry: registry,
      pluginRegistryToken: "from-file",
    });
    expect(resolveConfig({}, fromFile).pluginRegistry?.token).toBe("from-file");
    expect(
      resolveConfig(
        { MATE_PLUGIN_REGISTRY: "@other=https://o.test/", MATE_PLUGIN_REGISTRY_TOKEN: "e" },
        fromFile,
      ).pluginRegistry,
    ).toEqual({ scope: "@other", url: "https://o.test/", token: "e" });
  });

  test("malformed values stop startup naming the setting without echoing the token", () => {
    for (const bad of [
      "acme=https://r.test/",
      "@acme",
      "@acme=not a url",
      "@acme=https://u:p@r.test/",
    ]) {
      expect(() =>
        resolveConfig({ MATE_PLUGIN_REGISTRY: bad, MATE_PLUGIN_REGISTRY_TOKEN: "sekrit" }, noFile),
      ).toThrow(/MATE_PLUGIN_REGISTRY: /);
    }
  });

  test("a registry without a token fails, naming the token setting", () => {
    let message = "";
    try {
      resolveConfig({ MATE_PLUGIN_REGISTRY: registry }, noFile);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("MATE_PLUGIN_REGISTRY_TOKEN");
  });

  test("a stale allowlist is reported as removed, not enforced", () => {
    const config = resolveConfig({ MATE_ALLOWED_PLUGINS: "@acme/*" }, noFile);
    expect(config.removed).toEqual(["MATE_ALLOWED_PLUGINS"]);
    expect(SETTINGS.map((setting) => setting.env)).not.toContain("MATE_ALLOWED_PLUGINS");
  });
});

describe("the audience setting", () => {
  test("is taken from the environment or the file, the environment winning", () => {
    expect(resolveConfig({ MATE_AUDIENCE: "ba" }, noFile).audience).toBe("ba");
    expect(resolveConfig({}, file({ audience: "qa" })).audience).toBe("qa");
    expect(resolveConfig({ MATE_AUDIENCE: "ba" }, file({ audience: "qa" })).audience).toBe("ba");
  });

  test("an empty environment value clears the file's audience", () => {
    expect(resolveConfig({ MATE_AUDIENCE: "" }, file({ audience: "qa" })).audience).toBeNull();
  });

  test.each(["BA Team", "ba;rm", "-ba", "a".repeat(65)])("%j is not a usable name", (value) => {
    expect(() => resolveConfig({ MATE_AUDIENCE: value }, noFile)).toThrow(/MATE_AUDIENCE/);
  });
});

describe("the factory's Git author", () => {
  test("is Mate factory by default", () => {
    const { gitName, gitEmail } = resolveConfig({ MATE_FACTORY: "true" }, noFile).factory;
    expect({ gitName, gitEmail }).toEqual({
      gitName: "Mate factory",
      gitEmail: "factory@mate.invalid",
    });
  });

  test("comes from the file as well", () => {
    const config = resolveConfig(
      { MATE_FACTORY: "true" },
      file({ factoryGitName: "acme-mate-bot", factoryGitEmail: "mate-bot@acme.test" }),
    );
    expect(config.factory.gitName).toBe("acme-mate-bot");
    expect(config.factory.gitEmail).toBe("mate-bot@acme.test");
  });

  test("refuses an address Git would not accept, naming the setting", () => {
    expect(() =>
      resolveConfig({ MATE_FACTORY: "true", MATE_FACTORY_GIT_EMAIL: "Mate <bot>" }, noFile),
    ).toThrow(/MATE_FACTORY_GIT_EMAIL/);
  });
});

describe("the documented settings", () => {
  const reference = path.join(import.meta.dir, "..", "..", "docs", "content", "docs", "reference");
  const documented = ["deployment.mdx", "factory.mdx"].flatMap((page) =>
    [
      ...fs.readFileSync(path.join(reference, page), "utf8").matchAll(/^\| `([A-Z][A-Z0-9_]+)`/gm),
    ].map((match) => match[1]),
  );

  test("the appliance and factory tables together list exactly the settings the image has", () => {
    expect(documented.toSorted()).toEqual(SETTINGS.map((setting) => setting.env).toSorted());
  });
});

describe("factory mode", () => {
  test("is off by default and carries no credential", () => {
    expect(resolveConfig({}, noFile).factory).toEqual({
      enabled: false,
      credential: null,
      repositories: [],
      maxRuns: 2,
      stageMinutes: 60,
      gitName: "Mate factory",
      gitEmail: "factory@mate.invalid",
    });
  });

  test("ignores agent credentials while off", () => {
    expect(
      resolveConfig({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" }, noFile).factory,
    ).toEqual({
      enabled: false,
      credential: null,
      repositories: [],
      maxRuns: 2,
      stageMinutes: 60,
      gitName: "Mate factory",
      gitEmail: "factory@mate.invalid",
    });
  });

  test("takes a subscription token from the environment", () => {
    expect(
      resolveConfig({ MATE_FACTORY: "true", CLAUDE_CODE_OAUTH_TOKEN: "acme-token" }, noFile).factory
        .credential,
    ).toEqual({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "acme-token" });
  });

  test("takes an API key from the file", () => {
    expect(
      resolveConfig({}, file({ factory: true, anthropicApiKey: "acme-key" })).factory.credential,
    ).toEqual({ name: "ANTHROPIC_API_KEY", value: "acme-key" });
  });

  test("starts without a credential", () => {
    expect(resolveConfig({ MATE_FACTORY: "1" }, noFile).factory).toEqual({
      enabled: true,
      credential: null,
      repositories: [],
      maxRuns: 2,
      stageMinutes: 60,
      gitName: "Mate factory",
      gitEmail: "factory@mate.invalid",
    });
  });

  test("refuses both credentials without echoing either", () => {
    const resolve = () =>
      resolveConfig(
        { MATE_FACTORY: "1", CLAUDE_CODE_OAUTH_TOKEN: "secret-a", ANTHROPIC_API_KEY: "secret-b" },
        noFile,
      );
    expect(resolve).toThrow(/CLAUDE_CODE_OAUTH_TOKEN.*ANTHROPIC_API_KEY/);
    expect(resolve).not.toThrow(/secret-/);
  });

  test("refuses an unusable switch naming it", () => {
    expect(() => resolveConfig({ MATE_FACTORY: "maybe" }, noFile)).toThrow(/MATE_FACTORY/);
  });
});

describe("factory repositories", () => {
  test("are read from the environment, one per line or comma-separated", () => {
    const config = resolveConfig(
      {
        MATE_FACTORY: "true",
        MATE_FACTORY_REPOSITORIES:
          "https://git.acme.test/acme/web.git, git@git.acme.test:acme/api.git",
      },
      noFile,
    );
    expect(config.factory.repositories).toEqual([
      "https://git.acme.test/acme/web.git",
      "git@git.acme.test:acme/api.git",
    ]);
  });

  test("are read from the file as a list", () => {
    const config = resolveConfig(
      {},
      file({ factory: true, factoryRepositories: ["https://git.acme.test/acme/web.git"] }),
    );
    expect(config.factory.repositories).toEqual(["https://git.acme.test/acme/web.git"]);
  });

  test("an entry naming no org/repository stops startup naming it", () => {
    expect(() =>
      resolveConfig(
        { MATE_FACTORY: "true", MATE_FACTORY_REPOSITORIES: "https://git.acme.test/web" },
        noFile,
      ),
    ).toThrow(/MATE_FACTORY_REPOSITORIES.*names no org\/repository.*git\.acme\.test\/web/);
  });

  test.each([
    ["https://git.acme.test/acme/web.git", "acme/web"],
    ["git@git.acme.test:acme/web.git", "acme/web"],
    ["ssh://git@git.acme.test/group/acme/web", "acme/web"],
  ])("%s names %s", (url, repository) => {
    expect(repositoryOfUrl(url)).toBe(repository);
  });
});

describe("runner limits", () => {
  test("default to two runs and sixty minutes", () => {
    expect(resolveConfig({ MATE_FACTORY: "1" }, noFile).factory).toMatchObject({
      maxRuns: 2,
      stageMinutes: 60,
      gitName: "Mate factory",
      gitEmail: "factory@mate.invalid",
    });
  });

  test("are read from the file", () => {
    expect(
      resolveConfig({}, file({ factory: true, factoryMaxRuns: 4, factoryStageMinutes: 90 }))
        .factory,
    ).toMatchObject({ maxRuns: 4, stageMinutes: 90 });
  });

  test.each([
    ["MATE_FACTORY_MAX_RUNS", "0"],
    ["MATE_FACTORY_MAX_RUNS", "two"],
    ["MATE_FACTORY_STAGE_MINUTES", "-5"],
  ])("%s=%s stops startup naming the setting and value", (name, value) => {
    expect(() => resolveConfig({ MATE_FACTORY: "1", [name]: value }, noFile)).toThrow(
      new RegExp(`${name}.*${value}`),
    );
  });
});
