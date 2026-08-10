import { spawn } from "node:child_process";
import path from "node:path";

import { version } from "../../../../package.json";
import { FRAMEWORK_NAME } from "../../../framework";
import { getReactDoctorBinPath, getWrapperBinPath } from "../../package-paths";
import {
  GRAPHIFY_OUTPUT_SUBDIR,
  GRAPHIFY_STORE_SEGMENT,
} from "../../../tools/setup/capabilities/graphify";
import type { CapabilityConfig, GitModeProfile, LinkedRepository } from "../types";

export interface AdapterContext {
  repository: LinkedRepository;
  allowedAgents: string[];
  companionPath: string;
  capabilities: CapabilityConfig[];
  git?: GitModeProfile;
}

export interface AdapterResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PreparedLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  warning?: string;
}

function prependPathEntry(pathValue: string | undefined, entry: string): string {
  const entries = (pathValue ?? "").split(path.delimiter).filter(Boolean);
  return [entry, ...entries.filter((value) => value !== entry)].join(path.delimiter);
}

export abstract class LaunchAdapter {
  abstract readonly toolName: string;
  readonly interactive: boolean = false;

  abstract buildArgs(context: AdapterContext, args: string[]): string[];

  async validateLaunch(_context: AdapterContext): Promise<void> {}

  extendEnvironment(_context: AdapterContext): NodeJS.ProcessEnv {
    return {};
  }

  environment(context: AdapterContext): NodeJS.ProcessEnv {
    const reactDoctorEnabled = context.capabilities.some((c) => c.name === "react-doctor");
    const wrapperBinPath = getWrapperBinPath();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MATE_NAME: FRAMEWORK_NAME,
      MATE_VERSION: version,
      MATE_ARTIFACT_PATH: context.companionPath,
      MATE_WRAPPER_BIN_PATH: wrapperBinPath,
      PATH: prependPathEntry(process.env.PATH, wrapperBinPath),
      MATE_GRAPHIFY_ENABLED: context.capabilities.some((c) => c.name === "graphify") ? "1" : "0",
      MATE_OPENSPEC_ENABLED: context.capabilities.some((c) => c.name === "openspec") ? "1" : "0",
      MATE_REACT_DOCTOR_ENABLED: reactDoctorEnabled ? "1" : "0",
      MATE_GIT_AUTO_MODE: context.git === "auto" ? "1" : "0",
      MATE_REPO_ID: context.repository.id,
      MATE_REPO_PATH: context.repository.path,
      MATE_POLICY_JSON: JSON.stringify({ allowedAgents: context.allowedAgents }),
    };

    if (reactDoctorEnabled) {
      env.MATE_REACT_DOCTOR_BIN_PATH = getReactDoctorBinPath();
    } else {
      delete env.MATE_REACT_DOCTOR_BIN_PATH;
    }

    // Route launch-session graphify output to the companion store. graphifyy resolves its
    // output dir from GRAPHIFY_OUT at import time (graphify/paths.py) and every
    // reader honours it, so injecting it into the launch session env keeps the
    // skill's per-shell `$GRAPHIFY_OUT` references and graphifyy's own defaults
    // pointed at the companion store instead of leaking graphify-out/ into the
    // working repo. Absolute value, matching the wrapper and deriveGraphifyPaths contract.
    if (context.capabilities.some((c) => c.name === "graphify")) {
      env.GRAPHIFY_OUT = path.join(
        context.companionPath,
        GRAPHIFY_STORE_SEGMENT,
        context.repository.id,
        GRAPHIFY_OUTPUT_SUBDIR,
      );
    }

    return env;
  }

  async prepareLaunch(context: AdapterContext, args: string[]): Promise<PreparedLaunch> {
    const builtArgs = this.buildArgs(context, args);
    const baseEnv = this.environment(context);
    const extendedEnv = this.extendEnvironment(context);
    const env = { ...baseEnv, ...extendedEnv };

    const processPath = process.env.PATH ?? "";
    if (typeof extendedEnv.PATH === "string") {
      if (extendedEnv.PATH === processPath) {
        env.PATH = baseEnv.PATH;
      } else if (processPath.length > 0 && extendedEnv.PATH.endsWith(processPath)) {
        env.PATH = `${extendedEnv.PATH.slice(0, -processPath.length)}${baseEnv.PATH ?? ""}`;
      }
    }

    return { command: this.toolName, args: builtArgs, env };
  }

  async run(context: AdapterContext, args: string[]): Promise<AdapterResult> {
    const launch = await this.prepareLaunch(context, args);
    if (launch.warning) process.stderr.write(launch.warning);

    return new Promise((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd: context.repository.path,
        env: launch.env,
        stdio: this.interactive ? "inherit" : "pipe",
      });

      let stdout = "";
      let stderr = "";

      if (!this.interactive) {
        child.stdout?.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });
      }

      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({
          exitCode: exitCode ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }
}
