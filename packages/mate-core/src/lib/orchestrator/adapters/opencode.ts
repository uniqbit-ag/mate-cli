// oxlint-disable no-await-in-loop
import { spawnSync } from "node:child_process";

const fs = await import("node:fs/promises");
const path = await import("node:path");

import { MATE_ENV } from "../../../runtime/env";
import { validateGuidanceData, type MateGuidanceFile } from "../../../runtime/guidance";

import {
  getOpenCodePluginPackageReference,
  isMateOpenCodePluginReference,
  OPENCODE_PLUGIN_PACKAGE_NAME,
} from "../../opencode-plugin-package";
import { installedVersionAt, isPreinstalledPluginPath } from "../../preinstalled-plugins";
import {
  getOpenCodePluginReferences,
  mergeOpenCodeConfigContent,
  readOpenCodeConfig,
} from "../../../tools/setup/providers/opencode-format";
import { renderCompanionExternalDirectoryPermissions } from "../../../tools/setup/providers/opencode";
import { buildOpenCodeGuidance } from "../opencode-guidance";
import { LaunchPreflightError } from "../types";
import { type AdapterContext, LaunchAdapter } from "./base";

/** The Mate plugin is a V2 plugin; an older host rejects it at load time. */
const MIN_OPENCODE_MAJOR = 2;

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
    return args.length === 0 || args[0]?.startsWith("-") ? [codeDir, ...args] : args;
  }

  extendEnvironment(context: AdapterContext): NodeJS.ProcessEnv {
    return {
      OPENCODE_CONFIG_DIR: path.join(context.companionPath, ".opencode"),
      OPENCODE_CONFIG_CONTENT: mergeOpenCodeConfigContent(
        {
          permissions: renderCompanionExternalDirectoryPermissions(context.companionPath),
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

    const expectedPluginReference = getOpenCodePluginPackageReference();
    const errors: string[] = [
      ...(await this.validatePluginReference(
        context,
        path.join(".opencode", "opencode.json"),
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

    const { present, config } = await readOpenCodeConfig(configPath);
    if (!present) {
      return [`Unreadable OpenCode configuration: ${configPath}`];
    }

    const mateReferences = getOpenCodePluginReferences(config).filter(
      isMateOpenCodePluginReference,
    ) as string[];

    if (mateReferences.includes(expectedPluginReference)) {
      return [];
    }

    // Setup writes one of two spellings, and both are current: the published
    // spec on an ordinary workstation, and an absolute path into the
    // machine-local workspace where the distribution supplied an installed
    // copy. Comparing only against the spec would refuse the launch on exactly
    // the deployments preinstalled binding exists for.
    //
    // A bound reference carries its version in the package it points at rather
    // than in the string, so staleness is read off disk. It is still caught,
    // and now names the version actually installed.
    const expectedVersion = expectedPluginReference.slice(OPENCODE_PLUGIN_PACKAGE_NAME.length + 1);
    const bound = mateReferences.find((reference) =>
      isPreinstalledPluginPath(reference, OPENCODE_PLUGIN_PACKAGE_NAME),
    );
    if (bound !== undefined) {
      const version = await installedVersionAt(bound);
      if (version === expectedVersion) return [];
      return [
        `Stale Mate plugin package reference in ${configFile}: it points at ${bound}, which is ${version ?? "not installed"} rather than ${expectedVersion}.`,
      ];
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
