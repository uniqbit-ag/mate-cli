import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { stringify } from "yaml";

import { companionRegistryPath, globalConfigPath } from "./companion-registry-read";
import { companionFrameworkConfigPath, policyDocument, readCompanionPolicy } from "./policy";
import { projectionYamlPath, writeProjectionPair, type MateProjection } from "./projection";
import { repoLocalRegistryPath } from "./repo-local";
import { defaultSecretPolicy, parseSecretsConfig } from "./secret-patterns";
import {
  SESSION_CONTEXT_PROTOCOL,
  resolveSession,
  sessionContextFor,
  sessionContextReply,
  sessionRefusalNotice,
  type ResolvedSession,
} from "./session-resolution";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    chmodTree(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  repoRoot: string;
  companionPath: string;
  home: string;
  /** The environment of a plain session: only `HOME`, which names the Mate configuration. */
  env: { HOME: string };
}

interface FixtureOptions {
  /** The companion's `framework.yaml`, or none. */
  companionConfig?: string | null;
  /** Companion paths the user's Mate configuration registers. */
  registered?: (f: Fixture) => string[];
  /** Repositories the companion's registry links. */
  linked?: (f: Fixture) => Array<{ id: string; path: string }>;
}

/**
 * `acme-app` wrapped for the `acme` companion. By default the user's Mate
 * configuration registers the companion and its registry links the Checkout,
 * so the projection is trusted.
 */
function wrapped(options: FixtureOptions = {}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-resolution-")));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const f: Fixture = {
    root,
    repoRoot: path.join(root, "acme-app"),
    companionPath: path.join(root, "acme"),
    home,
    env: { HOME: home },
  };
  fs.mkdirSync(f.companionPath, { recursive: true });
  const {
    companionConfig = "allowedAgents:\n  - claude\ncapabilities:\n  - name: graphify\ngit: auto\n",
  } = options;
  if (companionConfig !== null)
    writeFile(companionFrameworkConfigPath(f.companionPath), companionConfig);

  writeFile(repoLocalRegistryPath(f.repoRoot), "companions: []\n");
  project(f.repoRoot, { companionPath: f.companionPath });

  const linked = (options.linked ?? ((x) => [{ id: "acme-app", path: x.repoRoot }]))(f);
  writeFile(companionRegistryPath(f.companionPath), stringify({ repos: linked }));
  register(f, (options.registered ?? ((x) => [x.companionPath]))(f));
  return f;
}

function project(repoRoot: string, overrides: Partial<MateProjection> = {}): void {
  writeProjectionPair(repoRoot, {
    stamp: "stamp",
    projection: {
      version: "0.18.5",
      companionPath: "/unset",
      repositoryPath: repoRoot,
      repositoryId: "acme-app",
      wrapperBinPath: "/install/mate/wrappers/bin",
      reactDoctorBinPath: "/install/mate/node_modules/.bin/react-doctor",
      graphifyOut: "/g",
      ...overrides,
    },
  });
}

function register(f: Fixture, companions: string[]): void {
  writeFile(
    globalConfigPath(f.home),
    stringify({ version: 1, companions: companions.map((p) => ({ path: p })) }),
  );
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function expectKind<K extends ResolvedSession["kind"]>(
  session: ResolvedSession,
  kind: K,
): Extract<ResolvedSession, { kind: K }> {
  expect(session.kind).toBe(kind);
  if (session.kind !== kind) throw new Error(`expected ${kind}, got ${session.kind}`);
  return session as Extract<ResolvedSession, { kind: K }>;
}

function refusalCode(session: ResolvedSession): string | undefined {
  return session.kind === "none" ? session.refusal?.code : `resolved:${session.kind}`;
}

/** Paths `fs.readFileSync` was asked for while `run` ran. */
function filesRead(run: () => void): string[] {
  const read = spyOn(fs, "readFileSync");
  try {
    run();
    return read.mock.calls.map(([file]) => String(file));
  } finally {
    read.mockRestore();
  }
}

function snapshot(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      const hash = entry.isFile()
        ? crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")
        : "";
      entries[path.relative(dir, full)] = `${stat.mtimeMs}:${hash}`;
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return entries;
}

function chmodTree(dir: string, mode: number): void {
  try {
    fs.chmodSync(dir, mode);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) chmodTree(path.join(dir, entry.name), mode);
    }
  } catch {}
}

describe("resolveSession: a launch", () => {
  test("answers a repository-scoped launch from the environment alone", () => {
    const session = expectKind(
      resolveSession(
        {
          MATE_ARTIFACT_PATH: "/companions/acme",
          MATE_REPO_PATH: "/repos/acme",
          MATE_REPO_ID: "acme",
          MATE_WRAPPER_BIN_PATH: "/install/mate/wrappers/bin",
          MATE_POLICY_JSON: '{"allowedAgents":["opencode"]}',
          MATE_GRAPHIFY_ENABLED: "1",
          MATE_GIT_AUTO_MODE: "0",
          MATE_REACT_DOCTOR_ENABLED: "1",
        },
        "/anywhere",
      ),
      "launch",
    );

    expect(session.scope).toBe("repository");
    expect(session.companionPath).toBe("/companions/acme");
    expect(session.checkoutRoot).toBe("/repos/acme");
    expect(session.repositoryId).toBe("acme");
    expect(session.wrapperBinPath).toBe("/install/mate/wrappers/bin");
    expect(session.policyJson()).toBe('{"allowedAgents":["opencode"]}');
    expect(session.flags()).toEqual({ graphify: true, gitAutoMode: false, reactDoctor: true });
  });

  test("answers a companion-scoped launch when the environment names no repository path", () => {
    const session = expectKind(
      resolveSession({ MATE_ARTIFACT_PATH: "/companions/acme" }, "/anywhere"),
      "launch",
    );

    expect(session.scope).toBe("companion");
    expect(session.checkoutRoot).toBe("");
    expect(session.repositoryId).toBe("");
  });

  test("treats flag values other than '1' as off and defaults the policy document", () => {
    const session = expectKind(
      resolveSession(
        {
          MATE_GRAPHIFY_ENABLED: "true",
          MATE_GIT_AUTO_MODE: "yes",
          MATE_REACT_DOCTOR_ENABLED: "0",
        },
        "/anywhere",
      ),
      "launch",
    );

    expect(session.flags()).toEqual({ graphify: false, gitAutoMode: false, reactDoctor: false });
    expect(session.policyJson()).toBe("{}");
    expect(session.companionPath).toBe("");
  });

  test("ignores a projection naming another companion, and does not read it", () => {
    const { repoRoot } = wrapped();

    let session: ResolvedSession | undefined;
    const read = filesRead(() => {
      session = resolveSession(
        { MATE_ARTIFACT_PATH: "/companions/from-env", MATE_REPO_PATH: "/repos/from-env" },
        repoRoot,
      );
    });

    const launch = expectKind(session!, "launch");
    expect(launch.companionPath).toBe("/companions/from-env");
    expect(launch.checkoutRoot).toBe("/repos/from-env");
    expect(read).toEqual([]);
  });

  test("any MATE_ variable keeps the environment authoritative", () => {
    const { repoRoot } = wrapped();

    expect(resolveSession({ MATE_NAME: "acme-mate" }, repoRoot).kind).toBe("launch");
  });

  test("a truncated projection cannot break a launch", () => {
    const { repoRoot } = wrapped();
    const yaml = projectionYamlPath(repoRoot);
    fs.writeFileSync(yaml, fs.readFileSync(yaml, "utf8").slice(0, 40), "utf8");

    const session = resolveSession({ MATE_ARTIFACT_PATH: "/companions/from-env" }, repoRoot);

    expect(expectKind(session, "launch").companionPath).toBe("/companions/from-env");
  });

  test("reads the launch companion's policy only when asked", () => {
    const { companionPath } = wrapped();

    let session: ResolvedSession | undefined;
    const before = filesRead(() => {
      session = resolveSession({ MATE_ARTIFACT_PATH: companionPath }, "/anywhere");
    });
    const launch = expectKind(session!, "launch");

    expect(before).toEqual([]);
    expect(launch.policy().gitAutoMode).toBe(true);
  });
});

describe("resolveSession: a trusted projection", () => {
  test("answers the projected companion, repository and Checkout", () => {
    const { repoRoot, companionPath, env } = wrapped();

    const session = expectKind(resolveSession(env, repoRoot), "projection");

    expect(session.companionPath).toBe(companionPath);
    expect(session.repositoryId).toBe("acme-app");
    expect(session.checkoutRoot).toBe(repoRoot);
    expect(session.projection.repoRoot).toBe(repoRoot);
    expect(session.projection.stamp).toBe("stamp");
    expect(session.projection.wrapperBinPath).toBe("/install/mate/wrappers/bin");
    expect(session.policyJson()).toBe(
      policyDocument({ allowedAgents: ["claude"], secrets: defaultSecretPolicy() }),
    );
    expect(session.flags()).toEqual({ graphify: true, gitAutoMode: true, reactDoctor: false });
  });

  test("answers the same companion for a folder below the Checkout", () => {
    const { repoRoot, companionPath, env } = wrapped();
    const below = path.join(repoRoot, "packages", "web");
    fs.mkdirSync(below, { recursive: true });

    const session = expectKind(resolveSession(env, below), "projection");

    expect(session.companionPath).toBe(companionPath);
    expect(session.checkoutRoot).toBe(repoRoot);
  });

  test("answers the Checkout it checked, not the repository path the projection claims", () => {
    const { root, repoRoot, companionPath, env } = wrapped();
    project(repoRoot, { companionPath, repositoryPath: path.join(root, "somewhere-else") });

    const session = expectKind(resolveSession(env, path.join(repoRoot, "src")), "projection");

    expect(session.checkoutRoot).toBe(repoRoot);
  });

  test("answers the companion's real path when the projection names a link to it", () => {
    const { root, repoRoot, companionPath, env } = wrapped();
    const link = path.join(root, "acme-link");
    fs.symlinkSync(companionPath, link);
    project(repoRoot, { companionPath: link });

    expect(expectKind(resolveSession(env, repoRoot), "projection").companionPath).toBe(
      companionPath,
    );
  });

  test("trusts a companion registered through a link to its folder", () => {
    const { env, repoRoot } = wrapped({
      registered: ({ root, companionPath }) => {
        const link = path.join(root, "acme-alias");
        fs.symlinkSync(companionPath, link);
        return [link];
      },
    });

    expect(resolveSession(env, repoRoot).kind).toBe("projection");
  });

  test("skips malformed registrations instead of refusing", () => {
    const f = wrapped();
    writeFile(
      globalConfigPath(f.home),
      stringify({
        version: 1,
        companions: [{ path: null }, { path: 7 }, { path: f.companionPath }],
      }),
    );

    expect(resolveSession(f.env, f.repoRoot).kind).toBe("projection");
  });

  test("reads the Mate configuration named by deps over the one under HOME", () => {
    const f = wrapped({ registered: () => [] });
    const configPath = path.join(f.root, "elsewhere", "config.yaml");
    writeFile(configPath, stringify({ version: 1, companions: [{ path: f.companionPath }] }));

    expect(resolveSession(f.env, f.repoRoot).kind).toBe("none");
    expect(resolveSession(f.env, f.repoRoot, { globalConfigPath: configPath }).kind).toBe(
      "projection",
    );
  });
});

describe("resolveSession: the companion policy", () => {
  test("is not read for a reader that needs only paths", () => {
    const { repoRoot, companionPath, env } = wrapped();

    let session: ResolvedSession | undefined;
    const read = filesRead(() => {
      session = resolveSession(env, repoRoot);
      const projection = expectKind(session, "projection");
      void projection.companionPath;
      void projection.checkoutRoot;
    });

    expect(read).not.toContain(companionFrameworkConfigPath(companionPath));
  });

  test("is read once per answer, then remembered", () => {
    const { repoRoot, companionPath, env } = wrapped();
    const session = expectKind(resolveSession(env, repoRoot), "projection");

    const read = filesRead(() => {
      session.policy();
      session.policyJson();
      session.flags();
      session.policy();
    });

    expect(
      read.filter((file) => file === companionFrameworkConfigPath(companionPath)),
    ).toHaveLength(1);
  });

  test("is read live: a Capability enabled before the session resolves shows enabled", () => {
    const { repoRoot, companionPath, env } = wrapped();
    expect(expectKind(resolveSession(env, repoRoot), "projection").flags().reactDoctor).toBe(false);

    writeFile(
      companionFrameworkConfigPath(companionPath),
      "allowedAgents: []\ncapabilities:\n  - name: react-doctor\n",
    );
    const session = expectKind(resolveSession(env, repoRoot), "projection");

    expect(session.flags()).toEqual({ graphify: false, gitAutoMode: false, reactDoctor: true });
    expect(session.policy()).toEqual(readCompanionPolicy(companionPath));
  });

  test("carries the companion's own secret rules in the policy document", () => {
    const { repoRoot, env } = wrapped({
      companionConfig:
        'allowedAgents:\n  - claude\nsecrets:\n  guardrails: false\n  deny: ["*.tfstate"]\n',
    });

    expect(expectKind(resolveSession(env, repoRoot), "projection").policyJson()).toBe(
      policyDocument({
        allowedAgents: ["claude"],
        secrets: parseSecretsConfig({ guardrails: false, deny: ["*.tfstate"] }),
      }),
    );
  });

  test("keeps the default protections when framework.yaml does not parse", () => {
    const { repoRoot, env } = wrapped({ companionConfig: "secrets: [unbalanced\n" });

    expect(expectKind(resolveSession(env, repoRoot), "projection").policyJson()).toBe(
      policyDocument({ allowedAgents: [], secrets: defaultSecretPolicy() }),
    );
  });

  test("reads allowedAgents from the legacy profiles block, as a launch does", () => {
    const { repoRoot, env } = wrapped({
      companionConfig: "profiles:\n  default:\n    allowedAgents: [claude]\n",
    });

    const session = expectKind(resolveSession(env, repoRoot), "projection");

    expect(JSON.parse(session.policyJson()).allowedAgents).toEqual(["claude"]);
  });
});

describe("resolveSession: an untrusted projection", () => {
  test("refuses a planted projection naming a companion that is not registered", () => {
    const { repoRoot, companionPath, env } = wrapped({ registered: () => [] });

    const session = resolveSession(env, repoRoot);

    expect(session).toEqual({
      kind: "none",
      refusal: {
        code: "companion-not-registered",
        companionPath,
        message: expect.stringContaining(companionPath),
      },
    });
  });

  test("refuses when the user has no Mate configuration, and writes none", () => {
    const f = wrapped();
    fs.rmSync(f.home, { recursive: true, force: true });

    expect(refusalCode(resolveSession(f.env, f.repoRoot))).toBe("companion-not-registered");
    expect(fs.existsSync(f.home)).toBe(false);
  });

  test("refuses a companion whose registry links the repository ID only at another path", () => {
    const { repoRoot, env } = wrapped({
      linked: () => [{ id: "acme-app", path: "/elsewhere/acme-app" }],
    });

    expect(refusalCode(resolveSession(env, repoRoot))).toBe("repository-not-linked");
  });

  test("refuses a link whose path matches but whose ID does not", () => {
    const { repoRoot, env } = wrapped({ linked: (f) => [{ id: "other", path: f.repoRoot }] });

    expect(refusalCode(resolveSession(env, repoRoot))).toBe("repository-not-linked");
  });

  test("refuses a companion without a registry", () => {
    const { repoRoot, companionPath, env } = wrapped();
    fs.rmSync(companionRegistryPath(companionPath));

    expect(refusalCode(resolveSession(env, repoRoot))).toBe("repository-not-linked");
  });

  test("refuses a clone whose projection claims another linked Checkout", () => {
    const { root, repoRoot, companionPath, env } = wrapped();
    const clone = path.join(root, "acme-clone");
    writeFile(repoLocalRegistryPath(clone), "companions: []\n");
    project(clone, { companionPath, repositoryPath: repoRoot });

    expect(refusalCode(resolveSession(env, path.join(clone, "src")))).toBe("repository-not-linked");
    expect(resolveSession(env, repoRoot).kind).toBe("projection");
  });

  test("refuses a projection whose companion no longer exists", () => {
    const { repoRoot, companionPath, env } = wrapped();
    fs.rmSync(companionPath, { recursive: true, force: true });

    const session = resolveSession(env, repoRoot);

    expect(refusalCode(session)).toBe("companion-missing");
    if (session.kind === "none") expect(session.refusal?.companionPath).toBe(companionPath);
  });

  test("names an unreadable Mate configuration as the reason it refuses", () => {
    const f = wrapped();
    writeFile(globalConfigPath(f.home), "version: 1\ncompanions: [\n  - path: : :\n");

    const session = resolveSession(f.env, f.repoRoot);

    expect(refusalCode(session)).toBe("companion-not-registered");
    if (session.kind === "none") {
      expect(session.refusal?.unreadable?.file).toBe(globalConfigPath(f.home));
      expect(session.refusal?.unreadable?.error).toEqual(expect.any(String));
    }
  });

  test("names an unreadable companion registry as the reason it refuses", () => {
    const { repoRoot, companionPath, env } = wrapped();
    writeFile(companionRegistryPath(companionPath), "repos: [\n  - id: : :\n");

    const session = resolveSession(env, repoRoot);

    expect(refusalCode(session)).toBe("repository-not-linked");
    if (session.kind === "none") {
      expect(session.refusal?.unreadable?.file).toBe(companionRegistryPath(companionPath));
    }
  });

  test("answers none without a refusal for a folder no projection covers", () => {
    const { root, env } = wrapped();
    const bare = path.join(root, "bare");
    fs.mkdirSync(bare);

    expect(resolveSession(env, bare)).toEqual({ kind: "none" });
  });

  test("answers none without a refusal for a truncated projection", () => {
    const { repoRoot, env } = wrapped();
    const yaml = projectionYamlPath(repoRoot);
    fs.writeFileSync(yaml, fs.readFileSync(yaml, "utf8").slice(0, 40), "utf8");

    expect(resolveSession(env, repoRoot)).toEqual({ kind: "none" });
  });
});

describe("resolveSession: a companion spelled with a link before `..`", () => {
  /** `<root>/d/fwd/../acme` leads to `<root>/acme`; `<root>/d/acme` is the decoy. */
  const configuredOf = (root: string) => `${root}/d/fwd/../acme`;

  function linkedFixture(registered: (f: Fixture) => string[]): Fixture {
    const f = wrapped({ registered, companionConfig: "git: auto\n" });
    const decoy = path.join(f.root, "d", "acme");
    fs.mkdirSync(path.join(f.root, "sub"), { recursive: true });
    fs.mkdirSync(path.join(f.root, "d"), { recursive: true });
    fs.symlinkSync(path.join(f.root, "sub"), path.join(f.root, "d", "fwd"));
    writeFile(
      companionRegistryPath(decoy),
      stringify({ repos: [{ id: "acme-app", path: f.repoRoot }] }),
    );
    writeFile(companionFrameworkConfigPath(decoy), "git: manual\nsecrets:\n  guardrails: false\n");
    return f;
  }

  test("a projection and registration with that spelling answer where it leads, with its policy", () => {
    const f = linkedFixture((x) => [configuredOf(x.root)]);
    project(f.repoRoot, { companionPath: configuredOf(f.root) });

    const session = expectKind(resolveSession(f.env, f.repoRoot), "projection");

    expect(session.companionPath).toBe(f.companionPath);
    expect(session.policyJson()).toBe(policyDocument(readCompanionPolicy(f.companionPath)));
    expect(session.flags().gitAutoMode).toBe(true);
  });

  test("a projection with that spelling matches the companion registered by its real path", () => {
    const f = linkedFixture((x) => [x.companionPath]);
    project(f.repoRoot, { companionPath: configuredOf(f.root) });

    expect(expectKind(resolveSession(f.env, f.repoRoot), "projection").companionPath).toBe(
      f.companionPath,
    );
  });

  test("a registration with that spelling matches the projection's real path", () => {
    const f = linkedFixture((x) => [configuredOf(x.root)]);

    expect(resolveSession(f.env, f.repoRoot).kind).toBe("projection");
  });

  test("the decoy's registration does not vouch for the companion the spelling leads to", () => {
    const f = linkedFixture((x) => [path.join(x.root, "d", "acme")]);
    project(f.repoRoot, { companionPath: configuredOf(f.root) });

    expect(refusalCode(resolveSession(f.env, f.repoRoot))).toBe("companion-not-registered");
  });

  test("from the launch environment answers where it leads", () => {
    const f = linkedFixture((x) => [x.companionPath]);

    const session = resolveSession({ MATE_ARTIFACT_PATH: configuredOf(f.root) }, "/anywhere");

    expect(expectKind(session, "launch").companionPath).toBe(f.companionPath);
  });
});

describe("resolveSession: read-only", () => {
  test("changes no file in the repository, the companion or the Mate home", () => {
    const f = wrapped();
    const below = path.join(f.repoRoot, "src");
    fs.mkdirSync(below);
    const before = snapshot(f.root);
    chmodTree(f.root, 0o555);

    try {
      expect(resolveSession(f.env, below).kind).toBe("projection");
      expectKind(resolveSession(f.env, f.repoRoot), "projection").policy();
      expect(resolveSession({ MATE_ARTIFACT_PATH: f.companionPath }, below).kind).toBe("launch");
    } finally {
      chmodTree(f.root, 0o755);
    }

    expect(snapshot(f.root)).toEqual(before);
  });

  test("answers without awaiting", () => {
    const { repoRoot, env } = wrapped();

    const session = resolveSession(env, repoRoot) as unknown;

    expect(session instanceof Promise).toBe(false);
  });
});

describe("sessionRefusalNotice", () => {
  test("names the refusal code and mate doctor, for the operator", () => {
    const { repoRoot, env } = wrapped({ registered: () => [] });
    const session = resolveSession(env, repoRoot);
    if (session.kind !== "none" || !session.refusal) throw new Error("expected a refusal");

    const notice = sessionRefusalNotice(session.refusal);

    expect(notice).toContain("companion-not-registered");
    expect(notice).toContain("`mate doctor`");
    expect(notice).toContain("without Mate");
  });

  test("names an unreadable file when that refused the projection", () => {
    const f = wrapped();
    writeFile(globalConfigPath(f.home), "companions: [\n  - path: : :\n");
    const session = resolveSession(f.env, f.repoRoot);
    if (session.kind !== "none" || !session.refusal) throw new Error("expected a refusal");

    expect(sessionRefusalNotice(session.refusal)).toContain(globalConfigPath(f.home));
  });
});

describe("sessionContextFor", () => {
  test("reports the companion, Checkout and policy of a trusted projection", () => {
    const { repoRoot, companionPath, home } = wrapped();

    expect(sessionContextFor(repoRoot, { globalConfigPath: globalConfigPath(home) })).toEqual({
      ok: true,
      context: {
        companionPath,
        repositoryPath: repoRoot,
        repositoryId: "acme-app",
        policyJson: policyDocument({ allowedAgents: ["claude"], secrets: defaultSecretPolicy() }),
      },
    });
  });

  test("ignores the launch environment", () => {
    const { repoRoot, companionPath, home } = wrapped();
    const previous = process.env.MATE_ARTIFACT_PATH;
    process.env.MATE_ARTIFACT_PATH = "/elsewhere";
    try {
      const result = sessionContextFor(repoRoot, { globalConfigPath: globalConfigPath(home) });
      expect(result.ok && result.context.companionPath).toBe(companionPath);
    } finally {
      if (previous === undefined) delete process.env.MATE_ARTIFACT_PATH;
      else process.env.MATE_ARTIFACT_PATH = previous;
    }
  });

  test("answers not-wrapped for a folder no projection covers", () => {
    const { root, home } = wrapped();

    const result = sessionContextFor(root, { globalConfigPath: globalConfigPath(home) });

    expect(result).toEqual({
      ok: false,
      error: { code: "not-wrapped", message: expect.stringContaining("projection") },
    });
  });

  test("answers a refusal by its code", () => {
    const { repoRoot, home } = wrapped({ linked: () => [] });

    const result = sessionContextFor(repoRoot, { globalConfigPath: globalConfigPath(home) });

    expect(result.ok ? "ok" : result.error.code).toBe("repository-not-linked");
  });

  test("throws for a file the trust check cannot read, instead of refusing", () => {
    const { repoRoot, companionPath, home } = wrapped();
    writeFile(companionRegistryPath(companionPath), "repos: [\n  - id: : :\n");

    expect(() =>
      sessionContextFor(repoRoot, { globalConfigPath: globalConfigPath(home) }),
    ).toThrow();
  });
});

describe("sessionContextReply", () => {
  test("puts the protocol beside a context", () => {
    const { repoRoot, home } = wrapped();
    const result = sessionContextFor(repoRoot, { globalConfigPath: globalConfigPath(home) });
    if (!result.ok) throw new Error(result.error.code);

    expect(sessionContextReply(result)).toEqual({
      protocol: SESSION_CONTEXT_PROTOCOL,
      ...result.context,
    });
    expect(SESSION_CONTEXT_PROTOCOL).toBe(1);
  });

  test("puts the protocol beside an error, with no companion or policy", () => {
    expect(
      sessionContextReply({ ok: false, error: { code: "not-wrapped", message: "no projection" } }),
    ).toEqual({ protocol: 1, error: { code: "not-wrapped", message: "no projection" } });
  });
});
