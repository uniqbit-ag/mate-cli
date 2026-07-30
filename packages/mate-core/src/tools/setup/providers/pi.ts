import fs from "node:fs/promises";
import path from "node:path";

import { confirm } from "../../../cli/confirm";
import {
  installPiMcpAdapter,
  inspectPiRuntime,
  PI_MCP_ADAPTER_INSTALL_COMMAND,
  PI_MCP_ADAPTER_MIN_VERSION,
  PI_MIN_VERSION,
  isSupportedVersion,
  piRuntimeDiagnostic,
} from "../../../lib/pi-runtime";
import type { SetupContext, McpServerDescriptor, ProviderPlugin } from "../plugin";
import { getSetupProvidersRoot } from "./utils";

export function getCompanionPiMcpConfigPath(companionPath: string): string {
  return path.join(companionPath, ".mcp.json");
}

export function getPiExtensionPath(): string {
  return path.join(getSetupProvidersRoot(), "pi", "mate-extension.ts");
}

function piMcpEntry(descriptor: McpServerDescriptor): Record<string, unknown> {
  if (descriptor.url) return { url: descriptor.url };
  return {
    command: descriptor.command ?? "",
    ...(descriptor.args ? { args: descriptor.args } : {}),
    ...(descriptor.env ? { env: descriptor.env } : {}),
  };
}

async function updatePiMcpServer(
  companionPath: string,
  name: string,
  entry: Record<string, unknown> | null,
): Promise<void> {
  const configPath = getCompanionPiMcpConfigPath(companionPath);
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Start with an empty managed config when absent or malformed.
  }

  const mcpServers =
    existing.mcpServers &&
    typeof existing.mcpServers === "object" &&
    !Array.isArray(existing.mcpServers)
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};
  if (entry === null) delete mcpServers[name];
  else mcpServers[name] = entry;

  const next = { ...existing };
  if (Object.keys(mcpServers).length > 0) next.mcpServers = mcpServers;
  else delete next.mcpServers;
  if (Object.keys(next).length === 0) {
    await fs.rm(configPath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

export async function ensurePiMcpAdapter(options: {
  interactive: boolean;
  confirmInstall?: typeof confirm;
  install?: typeof installPiMcpAdapter;
}): Promise<void> {
  const runtime = await inspectPiRuntime();
  const diagnostic = piRuntimeDiagnostic(runtime);
  if (!diagnostic) return;
  if (isSupportedVersion(runtime.piVersion, PI_MIN_VERSION) && options.interactive) {
    process.stdout.write(
      `${diagnostic}\nMate can install the required package globally with \`${PI_MCP_ADAPTER_INSTALL_COMMAND}\`.\n`,
    );
    const ok = await (options.confirmInstall ?? confirm)("Install it now? [y/N] ");
    if (ok) {
      await (options.install ?? installPiMcpAdapter)();
      const verified = await inspectPiRuntime();
      const verificationError = piRuntimeDiagnostic(verified);
      if (!verificationError) return;
      throw new Error(verificationError);
    }
  }
  throw new Error(diagnostic);
}

export async function piMcpPreflight(): Promise<string[]> {
  const diagnostic = piRuntimeDiagnostic(await inspectPiRuntime());
  return diagnostic ? [diagnostic] : [];
}

export function createPiPlugin(): ProviderPlugin {
  return {
    id: "pi",
    kind: "provider",
    label: "Pi",
    description: `Install Mate's bundled Pi extension (Pi ${PI_MIN_VERSION}+ and pi-mcp-adapter ${PI_MCP_ADAPTER_MIN_VERSION}+ required).`,
    defaultSelected: false,
    isEnabled: (config) => (config.profiles.default?.allowedAgents ?? []).includes("pi"),
    hosting: {
      mcp: {
        async register(ctx: SetupContext, descriptor: McpServerDescriptor) {
          await updatePiMcpServer(ctx.companionPath, descriptor.name, piMcpEntry(descriptor));
        },
        async unregister(ctx: SetupContext, name: string) {
          await updatePiMcpServer(ctx.companionPath, name, null);
        },
      },
      instructions: {
        getFilePath: (ctx: SetupContext) => path.join(ctx.companionPath, "AGENTS.md"),
      },
    },
    getInstallRequirements: () => [
      {
        id: "provider:pi-mcp-adapter",
        label: `Pi MCP adapter ${PI_MCP_ADAPTER_MIN_VERSION}+`,
        group: "companion",
        source: "Pi provider",
        command: PI_MCP_ADAPTER_INSTALL_COMMAND,
        fingerprint: `pi-mcp-adapter:${PI_MCP_ADAPTER_MIN_VERSION}`,
        detect: async () => !piRuntimeDiagnostic(await inspectPiRuntime()),
        install: installPiMcpAdapter,
        verify: async () => !piRuntimeDiagnostic(await inspectPiRuntime()),
      },
    ],
    async apply(ctx) {
      if (ctx.mode !== "setup") return;
      try {
        await ensurePiMcpAdapter({ interactive: true });
      } catch (error) {
        process.stderr.write(`pi: ${(error as Error).message}\n`);
      }
    },
    async teardown() {},
  };
}
