import fs from "node:fs";
import os from "node:os";

/**
 * Factory mode's preflight: what Sysbox and the inner Docker daemon need,
 * checked before anything starts so a missing prerequisite is named with its
 * fix rather than surfacing later as a failed Workset.
 */

/** Data directories that must be volumes: dockerd and Sysbox fail on overlayfs, and Worksets must survive restarts. */
export const FACTORY_VOLUMES = ["/var/lib/docker", "/var/lib/sysbox", "/var/lib/mate-factory"];

/** ID-mapped mounts plus overlayfs on them, which Sysbox uses instead of shiftfs. */
export const MIN_KERNEL: [number, number] = [5, 19];

export interface PreflightHost {
  uid: number;
  kernelRelease: string;
  readFile: (file: string) => string | null;
  exists: (file: string) => boolean;
}

export function defaultHost(): PreflightHost {
  return {
    uid: process.getuid?.() ?? -1,
    kernelRelease: os.release(),
    readFile: (file) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    exists: (file) => fs.existsSync(file),
  };
}

export interface PreflightFailure {
  check: string;
  fix: string;
}

/** Mount point → filesystem type, from `/proc/self/mountinfo`. */
export function mountTypes(mountinfo: string): Map<string, string> {
  const mounts = new Map<string, string>();
  for (const line of mountinfo.split("\n")) {
    const [left, right] = line.split(" - ");
    if (!left || !right) continue;
    const mountPoint = left.split(" ")[4];
    const type = right.split(" ")[0];
    if (mountPoint && type) mounts.set(mountPoint.replace(/\\040/g, " "), type);
  }
  return mounts;
}

function kernelAtLeast(release: string, [major, minor]: [number, number]): boolean {
  const match = /^(\d+)\.(\d+)/.exec(release);
  if (!match) return false;
  const [have, haveMinor] = [Number(match[1]), Number(match[2])];
  return have > major || (have === major && haveMinor >= minor);
}

/** Every capability the kernel knows is effective, which is what `--privileged` grants. */
function fullyCapable(status: string | null, lastCap: string | null): boolean {
  const effective = /^CapEff:\s*([0-9a-f]+)$/m.exec(status ?? "")?.[1];
  const last = Number(lastCap?.trim());
  if (!effective || !Number.isInteger(last)) return false;
  const all = (1n << BigInt(last + 1)) - 1n;
  return (BigInt(`0x${effective}`) & all) === all;
}

export function preflight(host: PreflightHost = defaultHost()): PreflightFailure[] {
  const failures: PreflightFailure[] = [];
  const fail = (check: string, fix: string) => failures.push({ check, fix });

  if (host.uid !== 0) {
    fail("the container runs as root", 'start it with `user: "0"` (`--user 0`)');
  }
  if (
    !fullyCapable(
      host.readFile("/proc/self/status"),
      host.readFile("/proc/sys/kernel/cap_last_cap"),
    )
  ) {
    fail("the container is privileged", "start it with `privileged: true` (`--privileged`)");
  }
  if (!host.exists("/sys/fs/cgroup/cgroup.controllers")) {
    fail("cgroup v2 is mounted at /sys/fs/cgroup", "run on a host that uses cgroup v2");
  }
  if (!host.exists("/dev/fuse")) {
    fail("/dev/fuse is available", "run privileged on a kernel with FUSE support");
  }
  if (!kernelAtLeast(host.kernelRelease, MIN_KERNEL)) {
    fail(
      `the kernel is ${MIN_KERNEL.join(".")} or newer (found ${host.kernelRelease})`,
      "update Docker Desktop or the host kernel",
    );
  }
  if (Number(host.readFile("/proc/sys/user/max_user_namespaces")?.trim() ?? 0) < 1) {
    fail("user namespaces are enabled", "set the host's user.max_user_namespaces above 0");
  }

  const mounts = mountTypes(host.readFile("/proc/self/mountinfo") ?? "");
  for (const volume of FACTORY_VOLUMES) {
    const type = mounts.get(volume);
    if (type === undefined) {
      fail(`${volume} is a mounted volume`, `mount a volume at ${volume}`);
    } else if (type === "overlay") {
      fail(
        `${volume} is not on overlayfs`,
        `mount a named volume at ${volume}, not a bind into the container's overlay`,
      );
    }
  }
  return failures;
}

export function renderFailures(failures: PreflightFailure[]): string {
  return failures.map(({ check, fix }) => `factory mode needs ${check}: ${fix}.`).join("\n");
}
