import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { PUBLIC_NPM_REGISTRY } from "./public-npm";

export const CONTEXT_MODE_PACKAGE_NAME = "context-mode";
export const CONTEXT_MODE_VERSION = "1.0.169";
export const CONTEXT_MODE_NODE_REQUIREMENT = ">=22.5.0";

export function getContextModePackageReference(): string {
  return `${CONTEXT_MODE_PACKAGE_NAME}@${CONTEXT_MODE_VERSION}`;
}

export function isContextModePackageReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === CONTEXT_MODE_PACKAGE_NAME || value.startsWith(`${CONTEXT_MODE_PACKAGE_NAME}@`))
  );
}

export function getContextModeInstallDir(companionPath: string): string {
  return path.join(companionPath, ".mate", "dependencies", CONTEXT_MODE_PACKAGE_NAME);
}

export function getContextModePackageRoot(companionPath: string): string {
  return path.join(
    getContextModeInstallDir(companionPath),
    "node_modules",
    CONTEXT_MODE_PACKAGE_NAME,
  );
}

export function isContextModeNodeVersionSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

export function validateContextModeNodeRuntime(): void {
  // env passed explicitly: bun's spawnSync otherwise ignores in-process PATH
  // changes when resolving the executable.
  const result = spawnSync("node", ["--version"], { encoding: "utf8", env: process.env });
  const version = result.stdout?.trim() ?? "";
  if (result.status !== 0 || !isContextModeNodeVersionSupported(version)) {
    throw new Error(
      `context-mode ${CONTEXT_MODE_VERSION} requires Node.js ${CONTEXT_MODE_NODE_REQUIREMENT}; found ${version || "no usable node executable"}.`,
    );
  }
}

export async function validateContextModePackage(companionPath: string): Promise<void> {
  validateContextModeNodeRuntime();
  const root = getContextModePackageRoot(companionPath);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
    version?: string;
  };
  if (manifest.version !== CONTEXT_MODE_VERSION) {
    throw new Error(
      `Expected ${getContextModePackageReference()} at ${root}; found ${manifest.version ?? "an unknown version"}. Re-run \`mate companion setup\`.`,
    );
  }
  await Promise.all(
    [
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "skills/context-mode/SKILL.md",
      "build/adapters/opencode/plugin.js",
    ].map((asset) => fs.access(path.join(root, asset))),
  );
}

export async function installContextModePackage(companionPath: string): Promise<void> {
  validateContextModeNodeRuntime();
  const installDir = getContextModeInstallDir(companionPath);
  await fs.mkdir(installDir, { recursive: true });
  await fs.writeFile(
    path.join(installDir, "package.json"),
    JSON.stringify(
      { private: true, dependencies: { [CONTEXT_MODE_PACKAGE_NAME]: CONTEXT_MODE_VERSION } },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const result = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--silent", "--registry", PUBLIC_NPM_REGISTRY],
    { cwd: installDir, encoding: "utf8", env: process.env },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not install ${getContextModePackageReference()}: ${result.error?.message ?? result.stderr?.trim() ?? `npm exited with ${result.status}`}`,
    );
  }
  await validateContextModePackage(companionPath);
}
