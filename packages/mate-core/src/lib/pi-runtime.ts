import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import semver from "semver";

import { runCommand } from "../tools/setup/utils";

export const PI_MIN_VERSION = "0.82.0";
export const PI_MCP_ADAPTER_PACKAGE = "pi-mcp-adapter";
export const PI_MCP_ADAPTER_MIN_VERSION = "2.15.0";
export const PI_MCP_ADAPTER_INSTALL_COMMAND = "pi install npm:pi-mcp-adapter";

export function getPiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
}

export function getPiMcpAdapterPackagePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getPiAgentDir(env), "npm", "node_modules", PI_MCP_ADAPTER_PACKAGE);
}

export function getPiMcpAdapterPackageJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getPiMcpAdapterPackagePath(env), "package.json");
}

export function getInstalledPiVersion(
  command = "pi",
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    const output = execFileSync(command, ["--version"], { encoding: "utf8", env });
    const match = output.trim().match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
    return match?.[0];
  } catch {
    return undefined;
  }
}

export async function getInstalledPiMcpAdapterVersion(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(getPiMcpAdapterPackageJsonPath(env), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export function isSupportedVersion(version: string | undefined, minimum: string): boolean {
  if (version === undefined) return false;
  const parsedVersion = semver.parse(version, { loose: true });
  const parsedMinimum = semver.parse(minimum, { loose: true });
  return (
    parsedVersion !== null && parsedMinimum !== null && semver.gte(parsedVersion, parsedMinimum)
  );
}

export async function inspectPiRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ piVersion?: string; mcpAdapterVersion?: string }> {
  return {
    piVersion: getInstalledPiVersion("pi", env),
    mcpAdapterVersion: await getInstalledPiMcpAdapterVersion(env),
  };
}

export function piRuntimeDiagnostic(runtime: {
  piVersion?: string;
  mcpAdapterVersion?: string;
}): string | undefined {
  if (!isSupportedVersion(runtime.piVersion, PI_MIN_VERSION)) {
    return `Pi ${PI_MIN_VERSION} or newer is required${runtime.piVersion ? ` (found ${runtime.piVersion})` : ""}. Install or update Pi before launching Mate Pi.`;
  }
  if (!isSupportedVersion(runtime.mcpAdapterVersion, PI_MCP_ADAPTER_MIN_VERSION)) {
    return `${PI_MCP_ADAPTER_PACKAGE} ${PI_MCP_ADAPTER_MIN_VERSION} or newer is required${runtime.mcpAdapterVersion ? ` (found ${runtime.mcpAdapterVersion})` : ""}. Install it with \`${PI_MCP_ADAPTER_INSTALL_COMMAND}\`.`;
  }
  return undefined;
}

export async function installPiMcpAdapter(): Promise<void> {
  await runCommand("pi", ["install", `npm:${PI_MCP_ADAPTER_PACKAGE}`]);
}
