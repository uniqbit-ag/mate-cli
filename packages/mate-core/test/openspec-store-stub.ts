import fs from "node:fs/promises";
import path from "node:path";

export function openSpecRegistryPath(dataHome: string): string {
  return path.join(dataHome, "openspec", "stores", "registry.yaml");
}

export async function writeOpenSpecRegistry(
  dataHome: string,
  stores: Record<string, string>,
): Promise<void> {
  const lines = ["version: 1", "stores:"];
  for (const [id, localPath] of Object.entries(stores)) {
    lines.push(`  ${id}:`, "    backend:", "      type: git", `      local_path: ${localPath}`);
  }
  await fs.mkdir(path.dirname(openSpecRegistryPath(dataHome)), { recursive: true });
  await fs.writeFile(openSpecRegistryPath(dataHome), `${lines.join("\n")}\n`);
}

/**
 * Stands in for the real binary: logs every call, and on `store register`
 * records the store the way OpenSpec does, or prints `stderr` and fails.
 */
export async function stubOpenSpec(
  root: string,
  dataHome: string,
  behaviour: { stderr?: string } = {},
): Promise<{ bin: string; calls: () => Promise<string[]> }> {
  const dir = path.join(root, "stub-bin");
  const log = path.join(root, "calls.log");
  const registry = openSpecRegistryPath(dataHome);
  await fs.mkdir(dir, { recursive: true });
  const register = behaviour.stderr
    ? [`echo "${behaviour.stderr}" >&2`, "exit 1"]
    : [
        'mkdir -p "$2/.openspec-store"',
        'printf "version: 1\\nid: %s\\n" "$4" > "$2/.openspec-store/store.yaml"',
        `mkdir -p "${path.dirname(registry)}"`,
        `printf "version: 1\\nstores:\\n  %s:\\n    backend:\\n      type: git\\n      local_path: %s\\n" "$4" "$2" > "${registry}"`,
      ];
  const bin = path.join(dir, "openspec");
  await fs.writeFile(
    bin,
    ["#!/usr/bin/env bash", `echo "$*" >> "${log}"`, "shift", ...register, ""].join("\n"),
  );
  await fs.chmod(bin, 0o755);
  return {
    bin,
    calls: async () => (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean),
  };
}
