import { describe, expect, test } from "bun:test";

import { mountTypes, preflight, type PreflightHost, renderFailures } from "./factory";

const MOUNTINFO = [
  "1 0 0:1 / / rw - overlay overlay rw",
  "2 1 0:2 / /var/lib/docker rw - btrfs /dev/vdb1 rw",
  "3 1 0:2 / /var/lib/sysbox rw - btrfs /dev/vdb1 rw",
  "4 1 0:2 / /var/lib/mate-factory rw - ext4 /dev/vdc1 rw",
].join("\n");

function host(overrides: Partial<PreflightHost> & { files?: Record<string, string> } = {}) {
  const files: Record<string, string> = {
    "/proc/self/status": "Name:\tbash\nCapEff:\t000001ffffffffff\n",
    "/proc/sys/kernel/cap_last_cap": "40\n",
    "/proc/sys/user/max_user_namespaces": "64271\n",
    "/proc/self/mountinfo": MOUNTINFO,
    ...overrides.files,
  };
  return {
    uid: 0,
    kernelRelease: "6.12.5-linuxkit",
    readFile: (file: string) => files[file] ?? null,
    exists: (file: string) => ["/sys/fs/cgroup/cgroup.controllers", "/dev/fuse"].includes(file),
    ...overrides,
  } satisfies PreflightHost;
}

describe("factory preflight", () => {
  test("a privileged root container with volumes passes", () => {
    expect(preflight(host())).toEqual([]);
  });

  test("not root is named with its fix", () => {
    expect(renderFailures(preflight(host({ uid: 10001 })))).toContain('user: "0"');
  });

  test("missing privileges are named", () => {
    const failures = preflight(
      host({ files: { "/proc/self/status": "CapEff:\t00000000a80425fb\n" } }),
    );
    expect(failures.map((failure) => failure.check)).toEqual(["the container is privileged"]);
    expect(renderFailures(failures)).toContain("--privileged");
  });

  test("an old kernel is named with the version found", () => {
    const [failure] = preflight(host({ kernelRelease: "5.15.0-generic" }));
    expect(failure?.check).toContain("found 5.15.0-generic");
  });

  test("missing FUSE and cgroup v2 are named", () => {
    const checks = preflight(host({ exists: () => false })).map((failure) => failure.check);
    expect(checks).toContain("/dev/fuse is available");
    expect(checks).toContain("cgroup v2 is mounted at /sys/fs/cgroup");
  });

  test("a missing state volume is named by its directory", () => {
    const failures = preflight(
      host({ files: { "/proc/self/mountinfo": MOUNTINFO.split("\n").slice(0, 3).join("\n") } }),
    );
    expect(failures.map((failure) => failure.check)).toEqual([
      "/var/lib/mate-factory is a mounted volume",
    ]);
  });

  test("a state directory on overlayfs is refused", () => {
    const failures = preflight(
      host({
        files: {
          "/proc/self/mountinfo": MOUNTINFO.replace(
            "/var/lib/docker rw - btrfs",
            "/var/lib/docker rw - overlay",
          ),
        },
      }),
    );
    expect(failures.map((failure) => failure.check)).toEqual([
      "/var/lib/docker is not on overlayfs",
    ]);
  });

  test("mount points are read from mountinfo", () => {
    expect(mountTypes(MOUNTINFO).get("/var/lib/mate-factory")).toBe("ext4");
  });
});
