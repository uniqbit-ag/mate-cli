import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { MATE_ENV } from "../../../runtime/env-names";
import { buildProjection, companionEnvironment, projectionEnvironment } from "../projection-record";
import type { CapabilityConfig, GitModeProfile, LinkedRepository } from "../types";

export interface AdapterContext {
  repository?: LinkedRepository;
  launchWorkingDirectory: string;
  allowedAgents: string[];
  companionPath: string;
  capabilities: CapabilityConfig[];
  git?: GitModeProfile;
  skipGit?: boolean;
}

export interface AdapterResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the agent process ended on a signal rather than its own exit. */
  signal?: NodeJS.Signals | null;
}

/** Forwarded from the launch to the agent so a supervisor above it can stop a session. */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * The shell convention: a signalled stop reads as 128 + the signal number, so a
 * caller can tell it from an ordinary non-zero exit.
 */
export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (os.constants.signals[signal] ?? 0);
}

export interface PreparedLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
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

  /**
   * The projected paths, materialized, plus the predicates the projection
   * refuses to hold. Nothing here derives a path: a managed session and an
   * Unmanaged Session read the same record, so they cannot disagree.
   */
  environment(context: AdapterContext): NodeJS.ProcessEnv {
    const reactDoctorEnabled = context.capabilities.some((c) => c.name === "react-doctor");
    const projection = context.repository
      ? projectionEnvironment(buildProjection(context.companionPath, context.repository))
      : companionEnvironment(context.companionPath);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...projection,
      MATE_NAME: FRAMEWORK_NAME,
      PATH: prependPathEntry(process.env.PATH, projection[MATE_ENV.wrapperBinPath] ?? ""),
      MATE_GRAPHIFY_ENABLED: context.capabilities.some((c) => c.name === "graphify") ? "1" : "0",
      MATE_OPENSPEC_ENABLED: context.capabilities.some((c) => c.name === "openspec") ? "1" : "0",
      MATE_REACT_DOCTOR_ENABLED: reactDoctorEnabled ? "1" : "0",
      MATE_GIT_AUTO_MODE: context.git === "auto" && !context.skipGit ? "1" : "0",
      MATE_POLICY_JSON: JSON.stringify({ allowedAgents: context.allowedAgents }),
    };

    if (!context.repository) {
      delete env[MATE_ENV.repositoryPath];
      delete env[MATE_ENV.repositoryId];
    }

    /** The one field where a launch still narrows the projection rather than materializing it. */
    if (!reactDoctorEnabled) delete env[MATE_ENV.reactDoctorBinPath];

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

  /**
   * A terminal delivers `SIGINT` to the whole foreground process group, so an
   * interactive launch at a TTY must not forward it as well — the agent would
   * be stopped twice. Where the signal reaches the launch alone (a supervisor,
   * a container entrypoint), forwarding is the only way it reaches the agent.
   */
  protected forwardsSignals(): boolean {
    return !(this.interactive && process.stdin.isTTY);
  }

  async run(context: AdapterContext, args: string[]): Promise<AdapterResult> {
    const launch = await this.prepareLaunch(context, args);

    return new Promise((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd: context.launchWorkingDirectory,
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

      const forward = this.forwardsSignals();
      const handlers = new Map<NodeJS.Signals, () => void>();
      for (const signal of FORWARDED_SIGNALS) {
        const handler = () => {
          /** Installing a handler at all is what keeps the launch alive to wait for the agent. */
          if (forward && child.exitCode === null && child.signalCode === null) {
            child.kill(signal);
          }
        };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
      const removeHandlers = () => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
        handlers.clear();
      };

      child.on("error", (error) => {
        removeHandlers();
        reject(error);
      });
      child.on("close", (exitCode, signal) => {
        removeHandlers();
        resolve({
          exitCode: exitCode ?? (signal ? signalExitCode(signal) : 1),
          stdout,
          stderr,
          signal: signal ?? null,
        });
      });
    });
  }
}
