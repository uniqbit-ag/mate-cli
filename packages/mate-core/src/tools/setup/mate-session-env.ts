import path from "node:path";

import { version } from "../../../package.json";
import { FRAMEWORK_NAME } from "../../framework";
import { getReactDoctorBinPath, getWrapperBinPath } from "../../lib/package-paths";
import type { FrameworkConfig, LinkedRepository } from "../../lib/orchestrator/types";
import { GRAPHIFY_OUTPUT_SUBDIR, GRAPHIFY_STORE_SEGMENT } from "./capabilities/graphify-shared";

/**
 * Every env key Mate may materialize into a session. Reconcilers strip this
 * whole set before applying the freshly built map so stale managed keys
 * (e.g. GRAPHIFY_OUT after graphify is disabled) never survive a sync,
 * while user-authored env keys are preserved untouched.
 */
export const MANAGED_SESSION_ENV_KEYS = [
  "MATE_NAME",
  "MATE_VERSION",
  "MATE_ARTIFACT_PATH",
  "MATE_WRAPPER_BIN_PATH",
  "MATE_GRAPHIFY_ENABLED",
  "MATE_OPENSPEC_ENABLED",
  "MATE_REACT_DOCTOR_ENABLED",
  "MATE_GIT_AUTO_MODE",
  "MATE_REPO_ID",
  "MATE_REPO_PATH",
  "MATE_POLICY_JSON",
  "MATE_REACT_DOCTOR_BIN_PATH",
  "GRAPHIFY_OUT",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
] as const;

export interface MateSessionEnvInput {
  companionPath: string;
  repository: LinkedRepository;
  config: FrameworkConfig;
}

/**
 * The MATE_* session contract previously injected at spawn time by the launch
 * adapters, now materialized into the settings `env` map so hooks, MCP
 * servers, and subprocesses observe it in sessions Mate did not spawn.
 * PATH prepending is intentionally absent: wrapper CLIs are invoked via the
 * absolute `MATE_WRAPPER_BIN_PATH` per the companion policy.
 */
export function buildMateSessionEnv(input: MateSessionEnvInput): Record<string, string> {
  const capabilities = input.config.capabilities ?? [];
  const hasCapability = (name: string) => capabilities.some((c) => c.name === name);
  const companionPath = path.resolve(input.companionPath);
  const reactDoctorEnabled = hasCapability("react-doctor");
  const graphifyEnabled = hasCapability("graphify");

  const env: Record<string, string> = {
    MATE_NAME: FRAMEWORK_NAME,
    MATE_VERSION: version,
    MATE_ARTIFACT_PATH: companionPath,
    MATE_WRAPPER_BIN_PATH: getWrapperBinPath(),
    MATE_GRAPHIFY_ENABLED: graphifyEnabled ? "1" : "0",
    MATE_OPENSPEC_ENABLED: hasCapability("openspec") ? "1" : "0",
    MATE_REACT_DOCTOR_ENABLED: reactDoctorEnabled ? "1" : "0",
    MATE_GIT_AUTO_MODE: input.config.git === "auto" ? "1" : "0",
    MATE_REPO_ID: input.repository.id,
    MATE_REPO_PATH: path.resolve(input.repository.path),
    MATE_POLICY_JSON: JSON.stringify({ allowedAgents: input.config.allowedAgents }),
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
  };

  if (reactDoctorEnabled) {
    env.MATE_REACT_DOCTOR_BIN_PATH = getReactDoctorBinPath();
  }
  if (graphifyEnabled) {
    env.GRAPHIFY_OUT = path.join(
      companionPath,
      GRAPHIFY_STORE_SEGMENT,
      input.repository.id,
      GRAPHIFY_OUTPUT_SUBDIR,
    );
  }

  return env;
}
