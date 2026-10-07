// oxlint-disable no-await-in-loop
import { spawnSync } from "node:child_process";

const fs = await import("node:fs/promises");
const path = await import("node:path");

import { MATE_ENV } from "../../../runtime/env";
import { validateGuidanceData, type MateGuidanceFile } from "../../../runtime/guidance";

import { getOpenCodePluginRoot, validateOpenCodePluginAssets } from "../../package-paths";
import {
  mergeOpenCodeConfigContent,
  readOpenCodeConfig,
} from "../../../tools/setup/providers/opencode-format";
import { renderCompanionExternalDirectoryPermissions } from "../../../tools/setup/providers/opencode";
import { buildOpenCodeGuidance } from "../opencode-guidance";
import { LaunchPreflightError } from "../types";
import { type AdapterContext, LaunchAdapter } from "./base";

/** The Mate plugin is a V2 plugin; an older host rejects it at load time. */
const MIN_OPENCODE_MAJOR = 2;

/**
 * OpenCode 2.x attaches to a shared background service by default; plugins and
 * config load in that server, so the per-launch Mate env never reaches it.
 */
const STANDALONE_FLAG = "--standalone";

/** Raw `opencode --version` output, or `undefined` when the binary cannot run. */
export type OpenCodeVersionProbe = () => string | undefined;

const probeOpenCodeVersion: OpenCodeVersionProbe = () => {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

function parseOpenCodeMajor(output: string | undefined): number | undefined {
  const match = output?.match(/(\d+)\.\d+\.\d+/);
  return match ? Number(match[1]) : undefined;
}

export class OpenCodeAdapter extends LaunchAdapter {
  readonly toolName = "opencode";
  readonly interactive = true;
  private readonly requiredRuntimeAssets = [path.join(".opencode", "opencode.json")] as const;

  constructor(private readonly probeVersion: OpenCodeVersionProbe = probeOpenCodeVersion) {
    super();
  }

  private validateOpenCodeVersion(): void {
    const output = this.probeVersion();
    const major = parseOpenCodeMajor(output);
    if (major !== undefined && major >= MIN_OPENCODE_MAJOR) return;
    throw new LaunchPreflightError(
      [
        output === undefined
          ? "OpenCode is not installed or `opencode --version` failed."
          : `OpenCode ${output} is not supported.`,
        `Mate requires OpenCode ${MIN_OPENCODE_MAJOR}.x or newer. Upgrade OpenCode and retry.`,
      ].join("\n"),
    );
  }

  buildArgs(context: AdapterContext, args: string[]): string[] {
    const codeDir = context.launchWorkingDirectory;
    const isTui = args.length === 0 || args[0]?.startsWith("-");
    const [command, ...rest] = isTui ? [codeDir, ...args] : args;
    if (!command) return args;
    const hostsServer = isTui || command === "run";
    const choosesServer = rest.some(
      (arg) => arg === "--standalone" || arg === "--server" || arg.startsWith("--server="),
    );
    return hostsServer && !choosesServer ? [command, STANDALONE_FLAG, ...rest] : [command, ...rest];
  }

  extendEnvironment(context: AdapterContext): NodeJS.ProcessEnv {
    return {
      OPENCODE_CONFIG_DIR: path.join(context.companionPath, ".opencode"),
      OPENCODE_CONFIG_CONTENT: mergeOpenCodeConfigContent(
        {
          permissions: renderCompanionExternalDirectoryPermissions(context.companionPath),
          plugins: [getOpenCodePluginRoot()],
          references: {
            mate: context.companionPath,
          },
        },
        process.env,
        { appendSkillPaths: [path.join(context.companionPath, ".agents", "skills")] },
      ),
      // Built fresh per launch from the live capability config; always set so
      // a stale value inherited from an outer Mate session can never leak in.
      [MATE_ENV.guidanceJson]: JSON.stringify(this.buildGuidance(context)),
    };
  }

  private buildGuidance(context: AdapterContext): MateGuidanceFile {
    return buildOpenCodeGuidance(context.capabilities, {
      companionScoped: !context.repository,
    });
  }

  async validateLaunch(context: AdapterContext): Promise<void> {
    this.validateOpenCodeVersion();

    const missingAssets = await Promise.all(
      this.requiredRuntimeAssets.map(async (asset) => {
        const assetPath = path.join(context.companionPath, asset);
        try {
          await fs.access(assetPath);
          return null;
        } catch {
          return assetPath;
        }
      }),
    );
    const missingAsset = missingAssets.find((asset): asset is string => asset !== null);
    if (missingAsset) {
      throw new LaunchPreflightError(
        [
          "OpenCode companion runtime is incomplete.",
          `Missing required runtime asset: ${missingAsset}`,
          "Repair the companion runtime by re-running `mate companion setup` in the companion repository.",
        ].join("\n"),
      );
    }

    /** Asset errors carry their own reinstall hint; only companion errors are repaired by setup. */
    const assetErrors = this.validatePluginAssets();
    const companionErrors = [
      ...(await this.validateConfigReadable(context)),
      ...this.validateGuidance(context),
    ];
    const errors = [...assetErrors, ...companionErrors];
    if (errors.length === 0) return;

    const lines = [
      "OpenCode companion runtime is invalid.",
      ...errors.map((error) => `- ${error}`),
    ];
    if (companionErrors.length > 0) {
      lines.push(
        "Repair the companion runtime by re-running `mate companion setup` in the companion repository or `mate opencode` from the working repository.",
      );
    }
    throw new LaunchPreflightError(lines.join("\n"));
  }

  /** Launch-time sync leaves unparseable user config untouched; OpenCode would fail on it at startup. */
  private async validateConfigReadable(context: AdapterContext): Promise<string[]> {
    const configPath = path.join(context.companionPath, ".opencode", "opencode.json");
    const { present } = await readOpenCodeConfig(configPath);
    return present ? [] : [`Unreadable OpenCode configuration: ${configPath}`];
  }

  private validatePluginAssets(): string[] {
    try {
      validateOpenCodePluginAssets();
      return [];
    } catch (error) {
      return [(error as Error).message];
    }
  }

  // Self-check the guidance payload this launch is about to inject so a
  // broken playbook template fails preflight instead of inside OpenCode.
  private validateGuidance(context: AdapterContext): string[] {
    const built = this.buildGuidance(context);
    const { guidance, errors } = validateGuidanceData(built);

    const needsCodebaseExplorationGuidance = context.capabilities.some(
      (capability) => capability.name === "graphify" || capability.name === "tokensave",
    );
    if (needsCodebaseExplorationGuidance && !guidance.codebaseExplorationGuidance.trim()) {
      errors.push("missing injected codebase exploration guidance");
    }

    return errors;
  }
}
