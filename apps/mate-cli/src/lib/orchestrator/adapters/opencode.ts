// oxlint-disable no-await-in-loop
const fs = await import("node:fs/promises");
const path = await import("node:path");

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
    skills.paths = [
      ...paths,
      ...options.appendSkillPaths.filter((skillPath) => !paths.includes(skillPath)),
    ];
    config.skills = skills;
  }

  return JSON.stringify(config);
}

export class OpenCodeAdapter extends LaunchAdapter {
  readonly toolName = "opencode";
  readonly interactive = true;

  private readonly guidanceFile = path.join(".opencode", ".mate-guidance.json");

  private readonly requiredRuntimeAssets = [
    path.join(".opencode", "opencode.json"),
    this.guidanceFile,
    path.join(".opencode", "plugins", "mate-companion.ts"),
    path.join(".opencode", "plugins", "mate-add-dir.ts"),
    path.join(".opencode", "plugins", "mate-companion-policy.ts"),
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
    };
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
    for (const asset of this.requiredRuntimeAssets) {
      const assetPath = path.join(context.companionPath, asset);

      try {
        await fs.access(assetPath);
      } catch {
        throw new LaunchPreflightError(
          [
            "OpenCode companion runtime is incomplete.",
            `Missing required runtime asset: ${assetPath}`,
            "Repair the companion runtime by re-running `mate companion setup` in the companion repository.",
          ].join("\n"),
        );
      }
    }

    const guidancePath = path.join(context.companionPath, this.guidanceFile);
    const errors: string[] = [];
    const guidance = JSON.parse(await fs.readFile(guidancePath, "utf8")) as {
      version?: number;
      companionGuidance?: string;
      codebaseExplorationGuidance?: string;
      errors?: string[];
    };

    if (guidance.version !== 1) {
      errors.push("Unsupported guidance file version.");
    }

    if (Array.isArray(guidance.errors)) {
      errors.push(...guidance.errors.filter(Boolean));
    }

    if (
      typeof guidance.companionGuidance !== "string" ||
      !guidance.companionGuidance.includes("<companion-policy ")
    ) {
      errors.push("Missing injected companion guidance.");
    }

    const needsCodebaseExplorationGuidance = context.capabilities.some(
      (capability) => capability.name === "graphify" || capability.name === "tokensave",
    );
    if (
      needsCodebaseExplorationGuidance &&
      (typeof guidance.codebaseExplorationGuidance !== "string" ||
        !guidance.codebaseExplorationGuidance.includes("<codebase-exploration-rules "))
    ) {
      errors.push("Missing injected codebase exploration guidance.");
    }

    if (errors.length > 0) {
      throw new LaunchPreflightError(
        [
          "OpenCode companion runtime is invalid.",
          ...errors.map((error) => `- ${error}`),
          "Repair the companion runtime by re-running `mate companion setup` in the companion repository or `mate opencode` from the working repository.",
        ].join("\n"),
      );
    }
  }
}
