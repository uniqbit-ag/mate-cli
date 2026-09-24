import { spawnSync } from "node:child_process";

export const CONTAINER_RUNTIME_ENV = "MATE_CONTAINER_RUNTIME";

/**
 * The container runtime the tests and the local build use.
 *
 * The supervisor is a bash 5.1 script, which is what the image carries and
 * what `wait -n -p` needs; a developer machine may well ship an older bash. So
 * the supervisor's cases run it inside a container rather than against
 * whatever `bash` happens to be first on PATH — which also means they exercise
 * the script in the environment it ships in.
 */
export function findContainerRuntime(env: NodeJS.ProcessEnv = process.env): string | null {
  /**
   * Named where both are installed but only one holds the image, as on CI
   * runners, where Buildx loads into Docker while Podman is found first.
   */
  const named = env[CONTAINER_RUNTIME_ENV]?.trim();
  if (named) return named;
  for (const candidate of ["podman", "docker"]) {
    const found = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (found.status === 0) return candidate;
  }
  return null;
}

/** A small Debian image with the same bash the appliance image has. */
export const TEST_BASE_IMAGE = "docker.io/library/debian:trixie-slim";
