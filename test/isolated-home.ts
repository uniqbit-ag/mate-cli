import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Names the temporary HOME a test run was started with; the guard compares it to the live HOME. */
export const TEST_HOME_ENV = "MATE_TEST_HOME";
/** Explicit opt-out for the rare run that must see the developer's real HOME. */
export const REAL_HOME_ENV = "MATE_TEST_REAL_HOME";

/**
 * Prepares `home` and returns the environment a test run starts with.
 *
 * State lives under the temporary HOME: Mate's own files, the update cache and
 * Git's global configuration. Caches keep pointing at the real ones, since they
 * hold nothing a test can corrupt and an empty one turns every install into a
 * full download.
 */
export function isolatedTestEnv(
  base: NodeJS.ProcessEnv,
  home: string,
  realHome: string,
): NodeJS.ProcessEnv {
  /**
   * Fresh, with nothing newer on either channel: no test reaches the registry
   * merely by entering `main()`, and none is gated on an update it did not seed.
   */
  const updateState = "lastChecked: 2099-01-01T00:00:00.000Z\nlatestVersion: null\n";
  fs.mkdirSync(path.join(home, ".mate"), { recursive: true });
  for (const file of ["update-state-uniqbit-mate.yaml", "update-state-uniqbit-mate-canary.yaml"]) {
    fs.writeFileSync(path.join(home, ".mate", file), updateState);
  }
  /** A fixed identity and branch, so no test depends on the developer's own gitconfig. */
  fs.writeFileSync(
    path.join(home, ".gitconfig"),
    "[user]\n\tname = Mate Tests\n\temail = tests@example.invalid\n[init]\n\tdefaultBranch = main\n",
  );

  const env: NodeJS.ProcessEnv = {
    ...base,
    HOME: home,
    USERPROFILE: home,
    [TEST_HOME_ENV]: home,
  };
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    delete env[name];
  }
  const caches: Array<[string, string]> = [
    ["BUN_INSTALL_CACHE_DIR", path.join(realHome, ".bun", "install", "cache")],
    ["npm_config_cache", path.join(realHome, ".npm")],
    ["CARGO_HOME", path.join(realHome, ".cargo")],
    ["RUSTUP_HOME", path.join(realHome, ".rustup")],
    ["UV_CACHE_DIR", path.join(realHome, ".cache", "uv")],
  ];
  for (const [name, dir] of caches) {
    if (env[name] === undefined && fs.existsSync(dir)) env[name] = dir;
  }
  Object.assign(env, containerRuntimeEnv(base, realHome));
  return env;
}

/**
 * The container runtime finds its daemon through files under HOME: Podman's
 * machine connection on macOS, Docker's context. Resolved here, while HOME is
 * still the real one, and handed on through each runtime's own variables.
 */
function containerRuntimeEnv(base: NodeJS.ProcessEnv, realHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const dockerConfig = path.join(realHome, ".docker");
  if (base.DOCKER_CONFIG === undefined && fs.existsSync(dockerConfig)) {
    env.DOCKER_CONFIG = dockerConfig;
  }
  if (base.CONTAINER_HOST === undefined) {
    const listed = spawnSync("podman", ["system", "connection", "list", "--format", "json"], {
      encoding: "utf8",
      env: base,
    });
    if (listed.status === 0) {
      try {
        const connections = JSON.parse(listed.stdout) as Array<{
          Default?: boolean;
          URI?: string;
          Identity?: string;
        }>;
        const chosen = connections.find((connection) => connection.Default);
        if (chosen?.URI) {
          env.CONTAINER_HOST = chosen.URI;
          if (chosen.Identity) env.CONTAINER_SSHKEY = chosen.Identity;
        }
      } catch {
        /** No connection list means a local runtime, which needs nothing from HOME. */
      }
    }
  }
  return env;
}
