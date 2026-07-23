import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

import { version } from "../../../../package.json";
import { frameworkConfig } from "../../../framework";
import { getReactDoctorBinPath, getWrapperBinPath } from "../../package-paths";
import {
  GRAPHIFY_OUTPUT_SUBDIR,
  GRAPHIFY_STORE_SEGMENT,
} from "../../../tools/setup/capabilities/graphify";
import {
  type SpawnProxyOpts,
  getProxyStderr,
  isProxyReachable as defaultIsProxyReachable,
  resolveHeadroomPort,
  spawnProxyBackground as defaultSpawnProxyBackground,
  waitForProxyReachable as defaultWaitForProxyReachable,
} from "../headroom/proxy";
import type { CapabilityConfig, GitModeProfile, LinkedRepository, PolicySettings } from "../types";

export interface AdapterContext {
  repository: LinkedRepository;
  policy: PolicySettings;
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

export interface ProxyDeps {
  isProxyReachable?: (port: number) => Promise<boolean>;
  spawnProxyBackground?: (opts: SpawnProxyOpts) => void;
  waitForProxyReachable?: (port: number) => Promise<boolean>;
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

  protected headroomEnv(
    _context: AdapterContext,
    _port: number,
    _companionPath: string,
    _env: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv {
    return {};
  }

  protected headroomWrapper(
    _context: AdapterContext,
    _args: string[],
    _env: NodeJS.ProcessEnv,
  ): PreparedLaunch | undefined {
    return undefined;
  }

  environment(context: AdapterContext): NodeJS.ProcessEnv {
    const reactDoctorEnabled = context.capabilities.some((c) => c.name === "react-doctor");
    const wrapperBinPath = getWrapperBinPath();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MATE_NAME: frameworkConfig.name,
      MATE_VERSION: version,
      MATE_ARTIFACT_PATH: context.companionPath,
      MATE_WRAPPER_BIN_PATH: wrapperBinPath,
      PATH: prependPathEntry(process.env.PATH, wrapperBinPath),
      MATE_GRAPHIFY_ENABLED: context.capabilities.some((c) => c.name === "graphify") ? "1" : "0",
      MATE_REACT_DOCTOR_ENABLED: reactDoctorEnabled ? "1" : "0",
      MATE_GIT_AUTO_MODE: context.git === "auto" ? "1" : "0",
      MATE_REPO_ID: context.repository.id,
      MATE_REPO_PATH: context.repository.path,
      MATE_REPO_PROFILE: context.repository.profile,
      MATE_POLICY_JSON: JSON.stringify(context.policy),
    };

    if (reactDoctorEnabled) {
      env.MATE_REACT_DOCTOR_BIN_PATH = getReactDoctorBinPath();
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

  async prepareLaunch(
    context: AdapterContext,
    args: string[],
    proxyDeps: ProxyDeps = {},
  ): Promise<PreparedLaunch> {
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

    // Headroom behaves like any other capability: when it is enabled the launch
    // is routed through the proxy, with no per-launch opt-in. It only falls back
    // to a direct launch if the `headroom` binary is missing or the proxy fails
    // to become ready (handled below).
    const headroomCap = context.capabilities.find((c) => c.name === "headroom");
    if (!headroomCap) {
      return { command: this.toolName, args: builtArgs, env };
    }

    if (!isCommandOnPath("headroom", env.PATH ?? process.env.PATH ?? "")) {
      return {
        command: this.toolName,
        args: builtArgs,
        env,
        warning: `${frameworkConfig.name}: headroom capability enabled but \`headroom\` was not found on PATH; install with \`uv tool install "headroom-ai[all]"\`; launching ${this.toolName} directly\n`,
      };
    }

    const wrappedLaunch = this.headroomWrapper(context, builtArgs, env);
    if (wrappedLaunch) return wrappedLaunch;

    const probeProxy = proxyDeps.isProxyReachable ?? defaultIsProxyReachable;
    const spawnProxy = proxyDeps.spawnProxyBackground ?? defaultSpawnProxyBackground;
    const waitForProxy = proxyDeps.waitForProxyReachable ?? defaultWaitForProxyReachable;

    const port = resolveHeadroomPort();
    const reachable = await probeProxy(port);
    if (!reachable) {
      const maxProxyStartAttempts = 3;
      let ready = false;

      for (let attempt = 1; attempt <= maxProxyStartAttempts; attempt += 1) {
        spawnProxy({ port });
        if (await waitForProxy(port)) {
          ready = true;
          break;
        }
      }

      if (!ready) {
        const proxyErr = getProxyStderr(port).trim();
        const errorDetail = proxyErr
          ? `\nProxy error:\n${proxyErr
              .split("\n")
              .map((line) => `  ${line}`)
              .join("\n")}`
          : "";
        return {
          command: this.toolName,
          args: builtArgs,
          env,
          warning: `${frameworkConfig.name}: headroom proxy failed to become ready on port ${port} after ${maxProxyStartAttempts} attempts; launching ${this.toolName} directly${errorDetail}\n`,
        };
      }
    }

    return {
      command: this.toolName,
      args: builtArgs,
      env: {
        ...env,
        ...this.headroomEnv(context, port, context.companionPath, env),
      },
    };
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

function isCommandOnPath(command: string, pathValue: string): boolean {
  if (!pathValue) return false;

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, command), constants.X_OK);
      return true;
    } catch {
      // continue
    }
  }

  return false;
}
