// oxlint-disable no-await-in-loop
const fs = await import("node:fs/promises");
const path = await import("node:path");

import { MATE_ENV } from "../../../runtime/env";
import { validateGuidanceData, type MateGuidanceFile } from "../../../runtime/guidance";

import {
  getOpenCodePluginPackageReference,
  isMateOpenCodePluginReference,
} from "../../opencode-plugin-package";
import { buildOpenCodeGuidance } from "../opencode-guidance";
import { LaunchPreflightError } from "../types";
import { type AdapterContext, LaunchAdapter } from "./base";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key];
    if (isRecord(targetValue) && isRecord(sourceValue)) {
      mergeConfig(targetValue, sourceValue);
      continue;
    }

    target[key] = sourceValue;
  }
}

function mergeOpenCodeConfigContent(
  overlay: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  options: { appendSkillPaths?: string[] } = {},
): string {
  let config: Record<string, unknown> = {};
  const existing = env.OPENCODE_CONFIG_CONTENT;

  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (isRecord(parsed)) {
        config = parsed;
      }
    } catch {
      // Ignore invalid inherited config content rather than breaking launch.
    }
  }

  mergeConfig(config, overlay);

  if (options.appendSkillPaths && options.appendSkillPaths.length > 0) {
    const skills = isRecord(config.skills) ? config.skills : {};
    const paths = Array.isArray(skills.paths) ? skills.paths : [];
    const existingPaths = new Set(paths);
    skills.paths = [
      ...paths,
      ...options.appendSkillPaths.filter((skillPath) => !existingPaths.has(skillPath)),
    ];
    config.skills = skills;
  }

  return JSON.stringify(config);
}

export class OpenCodeAdapter extends LaunchAdapter {
  readonly toolName = "opencode";
  readonly interactive = true;

  private readonly requiredRuntimeAssets = [
    path.join(".opencode", "opencode.json"),
    path.join(".opencode", "tui.json"),
  ] as const;

  buildArgs(context: AdapterContext, args: string[]): string[] {
    const codeDir = context.repository.path;
    return args.length === 0 || args[0]?.startsWith("-") ? [codeDir, ...args] : args;
  }

  extendEnvironment(context: AdapterContext): NodeJS.ProcessEnv {
    return {
      OPENCODE_CONFIG_DIR: path.join(context.companionPath, ".opencode"),
      OPENCODE_CONFIG_CONTENT: mergeOpenCodeConfigContent(
        {
          permission: {
            external_directory: {
              [context.companionPath]: "allow",
              [`${context.companionPath}/**`]: "allow",
            },
          },
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
    return buildOpenCodeGuidance(context.capabilities);
  }

  protected headroomEnv(
    context: AdapterContext,
    port: number,
    _companionPath: string,
    env: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv {
    const project = encodeURIComponent(context.repository.id);
    const baseUrl = `http://127.0.0.1:${port}/p/${project}`;
    const configContent = mergeOpenCodeConfigContent(
      {
        provider: {
          anthropic: {
            options: { baseURL: baseUrl },
          },
          openai: {
            options: { baseURL: `${baseUrl}/v1` },
          },
        },
      },
      env,
    );
    return {
      ANTHROPIC_BASE_URL: baseUrl,
      OPENAI_BASE_URL: `${baseUrl}/v1`,
      OPENCODE_CONFIG_CONTENT: configContent,
    };
  }

  async validateLaunch(context: AdapterContext): Promise<void> {
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

    const expectedPluginReference = getOpenCodePluginPackageReference();
    const errors: string[] = [
      ...(await this.validatePluginReference(
        context,
        path.join(".opencode", "opencode.json"),
        expectedPluginReference,
      )),
      ...(await this.validatePluginReference(
        context,
        path.join(".opencode", "tui.json"),
        expectedPluginReference,
      )),
      ...this.validateGuidance(context),
    ];

    if (errors.length > 0) {
      throw new LaunchPreflightError(
        [
          "OpenCode companion runtime is invalid.",
          ...errors.map((error) => `- ${error}`),
          `Expected Mate plugin package: ${expectedPluginReference}`,
          "Repair the companion runtime by re-running `mate companion setup` in the companion repository or `mate opencode` from the working repository.",
        ].join("\n"),
      );
    }
  }

  private async validatePluginReference(
    context: AdapterContext,
    configFile: string,
    expectedPluginReference: string,
  ): Promise<string[]> {
    const configPath = path.join(context.companionPath, configFile);

    let config: unknown;
    try {
      config = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch {
      return [`Unreadable OpenCode configuration: ${configPath}`];
    }

    const plugins =
      isRecord(config) && Array.isArray(config.plugin) ? (config.plugin as unknown[]) : [];
    const mateReferences = plugins.filter(isMateOpenCodePluginReference) as string[];

    if (mateReferences.includes(expectedPluginReference)) {
      return [];
    }

    if (mateReferences.length > 0) {
      return [
        `Stale Mate plugin package reference in ${configFile}: found ${mateReferences.join(", ")}.`,
      ];
    }

    return [`Missing Mate plugin package reference in ${configFile}.`];
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
