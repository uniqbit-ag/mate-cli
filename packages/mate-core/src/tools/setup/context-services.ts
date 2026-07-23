// oxlint-disable no-await-in-loop
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  InstructionsService,
  McpServerDescriptor,
  McpService,
  Plugin,
  ProviderHosting,
  ProviderPlugin,
  SetupContext,
  TemplatesService,
} from "./plugin";

// ---------------------------------------------------------------------------
// Bookkeeping manifest
//
// Records, per plugin, the MCP servers and instruction blocks it registered
// through the context services. Reconciliation removes exactly the entries a
// plugin no longer registers (including all of them on teardown).
// ---------------------------------------------------------------------------

interface PluginServiceRecord {
  mcpServers?: string[];
  instructionBlocks?: string[];
}

interface ContextServicesManifest {
  plugins: Record<string, PluginServiceRecord>;
}

export function getContextServicesManifestPath(
  companionPath: string,
  frameworkName: string,
): string {
  return path.join(companionPath, `.${frameworkName}`, "state", "context-services.json");
}

async function loadManifest(manifestPath: string): Promise<ContextServicesManifest> {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && "plugins" in parsed) {
      return parsed as ContextServicesManifest;
    }
  } catch {
    // Absent or unparseable — start fresh.
  }
  return { plugins: {} };
}

async function saveManifest(
  manifestPath: string,
  manifest: ContextServicesManifest,
): Promise<void> {
  if (Object.keys(manifest.plugins).length === 0) {
    await fs.rm(manifestPath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Managed instruction blocks
// ---------------------------------------------------------------------------

function blockMarkers(frameworkName: string, blockKey: string): { start: string; end: string } {
  return {
    start: `<!-- ${frameworkName}:managed:${blockKey} start -->`,
    end: `<!-- ${frameworkName}:managed:${blockKey} end -->`,
  };
}

export function instructionBlockKey(pluginId: string, content: string): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `${pluginId}:${hash}`;
}

/** Insert (or leave untouched) a marker-delimited block. Idempotent per key. */
export async function upsertManagedBlock(
  filePath: string,
  frameworkName: string,
  blockKey: string,
  content: string,
): Promise<void> {
  const { start, end } = blockMarkers(frameworkName, blockKey);
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    // Absent — the block becomes the file's first content.
  }
  const block = `${start}\n${content.trim()}\n${end}\n`;
  if (existing.includes(start)) return;
  const separator = existing.length === 0 || existing.endsWith("\n\n") ? "" : "\n";
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, existing + (existing ? separator : "") + block, "utf8");
}

/** Remove a marker-delimited block if present. No-op when file or block is absent. */
export async function removeManagedBlock(
  filePath: string,
  frameworkName: string,
  blockKey: string,
): Promise<void> {
  const { start, end } = blockMarkers(frameworkName, blockKey);
  let existing: string;
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  const startIdx = existing.indexOf(start);
  if (startIdx === -1) return;
  const endIdx = existing.indexOf(end, startIdx);
  if (endIdx === -1) return;
  const before = existing.slice(0, startIdx).replace(/\n+$/, "\n");
  const after = existing.slice(endIdx + end.length).replace(/^\n+/, "\n");
  const next = (before + after).replace(/^\n+/, "");
  if (!next.trim()) {
    await fs.unlink(filePath).catch(() => {});
    return;
  }
  await fs.writeFile(filePath, next, "utf8");
}

// ---------------------------------------------------------------------------
// Asset resolution (distribution overrides win over core defaults)
// ---------------------------------------------------------------------------

/**
 * Distribution asset roots mirror core's asset layout: `templates/**`,
 * `playbooks/**`, and `wrappers/bin/*` below the root. Core's own templates
 * live at `src/templates`.
 */
export async function resolveTemplateAsset(
  templatePath: string,
  overrideRoots: string[] = [],
): Promise<string> {
  const candidates = [
    ...overrideRoots.map((root) => path.join(root, "templates", templatePath)),
    path.join(import.meta.dirname, "../../templates", templatePath),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next root in the chain.
    }
  }
  throw new Error(`template not found in any asset root: ${templatePath}`);
}

// ---------------------------------------------------------------------------
// Engine-side service mediation
// ---------------------------------------------------------------------------

export interface HostingProvider {
  id: string;
  hosting: ProviderHosting;
}

export function collectHostingProviders(
  plugins: Plugin[],
  activeProviders: string[],
): HostingProvider[] {
  return plugins
    .filter(
      (plugin): plugin is ProviderPlugin =>
        plugin.kind === "provider" &&
        activeProviders.includes(plugin.id) &&
        (plugin as ProviderPlugin).hosting !== undefined,
    )
    .map((plugin) => ({ id: plugin.id, hosting: plugin.hosting as ProviderHosting }));
}

export interface PluginContextServices {
  services: { mcp: McpService; instructions: InstructionsService; templates: TemplatesService };
  /** MCP server names and instruction block keys registered during this run. */
  registered: { mcpServers: Set<string>; instructionBlocks: Set<string> };
}

export interface ContextServiceMediatorOptions {
  ctx: SetupContext;
  frameworkName: string;
  hostingProviders: HostingProvider[];
  assetOverrideRoots?: string[];
  warn(message: string): void;
}

/**
 * Mediates context-service calls for one plan execution. Each plugin gets a
 * scoped service set that records what it registered; `finalize()` reconciles
 * the bookkeeping manifest and removes entries no longer registered.
 */
export class ContextServiceMediator {
  private readonly byPlugin = new Map<string, PluginContextServices>();

  constructor(private readonly options: ContextServiceMediatorOptions) {}

  servicesFor(pluginId: string): PluginContextServices["services"] {
    return this.entryFor(pluginId).services;
  }

  /** Ensure a plugin participates in reconciliation even if it never calls a service. */
  track(pluginId: string): void {
    this.entryFor(pluginId);
  }

  private entryFor(pluginId: string): PluginContextServices {
    let entry = this.byPlugin.get(pluginId);
    if (entry) return entry;

    const { ctx, frameworkName, hostingProviders, warn } = this.options;
    const registered = { mcpServers: new Set<string>(), instructionBlocks: new Set<string>() };

    const mcp: McpService = {
      register: async (descriptor: McpServerDescriptor) => {
        const hosts = hostingProviders.filter((provider) => provider.hosting.mcp);
        if (hosts.length === 0) {
          warn(
            `${pluginId}: no active provider hosts MCP registration; skipping "${descriptor.name}"`,
          );
          return;
        }
        for (const provider of hosts) {
          await provider.hosting.mcp?.register(ctx, descriptor);
        }
        registered.mcpServers.add(descriptor.name);
      },
    };

    const instructions: InstructionsService = {
      append: async (content: string) => {
        const hosts = hostingProviders.filter((provider) => provider.hosting.instructions);
        if (hosts.length === 0) {
          warn(`${pluginId}: no active provider hosts instruction injection; skipping append`);
          return;
        }
        const blockKey = instructionBlockKey(pluginId, content);
        for (const provider of hosts) {
          const filePath = provider.hosting.instructions?.getFilePath(ctx);
          if (!filePath) continue;
          await upsertManagedBlock(filePath, frameworkName, blockKey, content);
        }
        registered.instructionBlocks.add(blockKey);
      },
    };

    const templates: TemplatesService = {
      render: async (templatePath, destination, data) => {
        const resolved = await resolveTemplateAsset(
          templatePath,
          this.options.assetOverrideRoots ?? [],
        );
        let content = await fs.readFile(resolved, "utf8");
        if (data) {
          content = content.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
            key in data ? data[key] : match,
          );
        }
        const destPath = path.isAbsolute(destination)
          ? destination
          : path.join(ctx.companionPath, destination);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, content, "utf8");
      },
    };

    entry = { services: { mcp, instructions, templates }, registered };
    this.byPlugin.set(pluginId, entry);
    return entry;
  }

  /**
   * Reconcile the bookkeeping manifest: remove provider entries that were
   * previously registered but not re-registered in this run, then persist the
   * new registration state.
   */
  async finalize(): Promise<void> {
    const { ctx, frameworkName, hostingProviders } = this.options;
    const manifestPath = getContextServicesManifestPath(ctx.companionPath, frameworkName);
    const manifest = await loadManifest(manifestPath);

    for (const [pluginId, entry] of this.byPlugin) {
      const previous = manifest.plugins[pluginId] ?? {};
      const staleMcpServers = (previous.mcpServers ?? []).filter(
        (name) => !entry.registered.mcpServers.has(name),
      );
      const staleBlocks = (previous.instructionBlocks ?? []).filter(
        (blockKey) => !entry.registered.instructionBlocks.has(blockKey),
      );

      for (const provider of hostingProviders) {
        for (const name of staleMcpServers) {
          await provider.hosting.mcp?.unregister(ctx, name);
        }
        const instructionsFilePath = provider.hosting.instructions?.getFilePath(ctx);
        if (instructionsFilePath) {
          for (const blockKey of staleBlocks) {
            await removeManagedBlock(instructionsFilePath, this.options.frameworkName, blockKey);
          }
        }
      }

      const record: PluginServiceRecord = {};
      if (entry.registered.mcpServers.size > 0) {
        record.mcpServers = [...entry.registered.mcpServers];
      }
      if (entry.registered.instructionBlocks.size > 0) {
        record.instructionBlocks = [...entry.registered.instructionBlocks];
      }
      if (Object.keys(record).length > 0) {
        manifest.plugins[pluginId] = record;
      } else {
        delete manifest.plugins[pluginId];
      }
    }

    await saveManifest(manifestPath, manifest);
  }
}
