/**
 * Test support: an SSH command for `GIT_SSH_COMMAND` that records its argv to
 * `MATE_TEST_SSH_LOG` and acts per `MATE_TEST_SSH_MODE`. `ok` serves the
 * request from the local filesystem (the repository path is taken from `/`);
 * `passphrase` and `hostkey` fail as OpenSSH does under `BatchMode=yes` and
 * otherwise hang as a waiting prompt would; `slow` hangs; `delay` fails after
 * one second; anything else is a refused connection.
 */
import fs from "node:fs";
import path from "node:path";

const SSH_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$MATE_TEST_SSH_LOG"
batch=no
for arg in "$@"; do [ "$arg" = "BatchMode=yes" ] && batch=yes; done
for last; do :; done
case "$MATE_TEST_SSH_MODE" in
  ok) cd / && exec sh -c "$last" ;;
  passphrase)
    [ "$batch" = yes ] && { echo "git@example.test: Permission denied (publickey)." >&2; exit 255; }
    sleep 30; exit 255 ;;
  hostkey)
    [ "$batch" = yes ] && { echo "Host key verification failed." >&2; exit 255; }
    sleep 30; exit 255 ;;
  slow) sleep 30; exit 255 ;;
  delay) sleep 1; echo "ssh: connect to host example.test port 22: Connection timed out" >&2; exit 255 ;;
  *) echo "ssh: connect to host example.test port 22: Connection refused" >&2; exit 255 ;;
esac
`;

export type SshStubMode = "ok" | "passphrase" | "hostkey" | "slow" | "delay" | "refused";

export function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function writeSshStub(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, "ssh-stub");
  fs.writeFileSync(stub, SSH_STUB, { mode: 0o755 });
  return stub;
}

/** SSH URL the stub serves for a local bare repository. */
export function stubSshUrl(barePath: string): string {
  return `git@example.test:${barePath.slice(1)}`;
}

/** HTTPS URL that Git resolves to `barePath` through `stubSshEnv`'s `insteadOf`. */
export function stubHttpsUrl(barePath: string): string {
  return `https://example.test${barePath}`;
}

export interface SshStub {
  env(mode: SshStubMode, extra?: Record<string, string>): Record<string, string | undefined>;
  calls(): string[];
}

/**
 * `root` must contain every bare repository the test reaches over HTTP(S):
 * those URLs resolve through `url.<root>/.insteadOf`.
 */
export function makeSshStub(root: string): SshStub {
  const stub = writeSshStub(path.join(root, "ssh-stub-bin"));
  const log = path.join(root, "ssh-stub.log");
  return {
    env: (mode, extra = {}) => ({
      ...process.env,
      GIT_SSH_COMMAND: shellQuoted(stub),
      GIT_SSH_VARIANT: "ssh",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${root}/.insteadOf`,
      GIT_CONFIG_VALUE_0: `https://example.test${root}/`,
      MATE_TEST_SSH_MODE: mode,
      MATE_TEST_SSH_LOG: log,
      ...extra,
    }),
    calls: () =>
      fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
  };
}
