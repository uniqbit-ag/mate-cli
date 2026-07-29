import { existsSync } from "node:fs";

import { buildCompanionGuidance } from "../../../playbooks/companion-guidance";
import path from "node:path";
import { LaunchPreflightError } from "../types";
import {
  ensurePiMcpAdapter,
  getCompanionPiMcpConfigPath,
  getPiExtensionPath,
} from "../../../tools/setup/providers/pi";
import { type AdapterContext, LaunchAdapter } from "./base";

export class PiAdapter extends LaunchAdapter {
  readonly toolName = "pi";
  readonly interactive = true;

  buildArgs(context: AdapterContext, args: string[]): string[] {
    const mcpConfigPath = getCompanionPiMcpConfigPath(context.companionPath);
    return [
      "--extension",
      getPiExtensionPath(),
      ...(existsSync(mcpConfigPath) ? ["--mcp-config", mcpConfigPath] : []),
      "--skill",
      path.join(context.companionPath, ".agents", "skills"),
      "--skill",
      path.join(context.companionPath, ".pi", "skills"),
      ...args,
    ];
  }

  extendEnvironment(context: AdapterContext): NodeJS.ProcessEnv {
    return {
      MATE_PI_GUIDANCE: buildCompanionGuidance(context),
      PI_MATE_ARTIFACT_PATH: context.companionPath,
      PI_MATE_REPO_PATH: context.repository.path,
    };
  }

  protected headroomEnv(context: AdapterContext, port: number): NodeJS.ProcessEnv {
    const project = encodeURIComponent(context.repository.id);
    const baseUrl = `http://127.0.0.1:${port}/p/${project}`;
    return {
      ANTHROPIC_BASE_URL: baseUrl,
      OPENAI_BASE_URL: `${baseUrl}/v1`,
    };
  }

  async validateLaunch(): Promise<void> {
    try {
      await ensurePiMcpAdapter({ interactive: false });
    } catch (error) {
      throw new LaunchPreflightError((error as Error).message, { cause: error });
    }

    const extensionPath = getPiExtensionPath();
    if (!existsSync(extensionPath)) {
      throw new LaunchPreflightError(
        `Mate Pi extension is missing: ${extensionPath}. Repair the Mate installation before launching Pi.`,
      );
    }
  }
}
