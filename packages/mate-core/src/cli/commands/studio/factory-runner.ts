import path from "node:path";

import { attachSocketFor, FACTORY_BROKER_ENV, factoryClient } from "../../../lib/factory/client";
import { runCommand } from "../../../lib/factory/command";
import { prepareWorkset } from "../../../lib/factory/prepare";
import { createHarnessStageAgent } from "../../../lib/factory/runner/harness-agent";
import { FactoryRunner } from "../../../lib/factory/runner/scheduler";
import { RunStore } from "../../../lib/factory/runner/state";
import { type StageAgent, StageError } from "../../../lib/factory/runner/workflow";

/** Studio's AFK runner, in factory mode only, for the companion the appliance serves. */

const FACTORY_STATE_DIR_ENV = "MATE_FACTORY_STATE_DIR";
const FACTORY_MAX_RUNS_ENV = "MATE_FACTORY_MAX_RUNS";
const FACTORY_STAGE_MINUTES_ENV = "MATE_FACTORY_STAGE_MINUTES";
const FACTORY_GIT_NAME_ENV = "MATE_FACTORY_GIT_NAME";
const FACTORY_GIT_EMAIL_ENV = "MATE_FACTORY_GIT_EMAIL";
/** The author of every commit the factory makes, unless the operator names another. */
const FACTORY_GIT_AUTHOR = { name: "Mate factory", email: "factory@mate.invalid" };

/**
 * Git's author and committer for the runner's commands: the factory's own identity,
 * whatever Git is configured with, so `git log` tells factory commits apart.
 */
export function factoryGitEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const name = env[FACTORY_GIT_NAME_ENV]?.trim() || FACTORY_GIT_AUTHOR.name;
  const email = env[FACTORY_GIT_EMAIL_ENV]?.trim() || FACTORY_GIT_AUTHOR.email;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

const DEFAULT_STATE_DIR = "/var/lib/mate-factory";
/** The unprivileged user's home inside Workset containers. */
const WORKSET_HOME = "/home/mate";

export interface StudioFactoryRunner {
  runner: FactoryRunner;
  store: RunStore;
  companionPath: string;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function createStudioFactoryRunner(
  companionPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StudioFactoryRunner | null> {
  const broker = env[FACTORY_BROKER_ENV];
  const client = factoryClient(broker);
  if (!broker || !client || !companionPath) return null;
  const stateDir = env[FACTORY_STATE_DIR_ENV] || DEFAULT_STATE_DIR;
  const store = new RunStore(path.join(stateDir, "runs"));
  await store.interruptActive();

  const harness = createHarnessStageAgent({
    client,
    attachSocket: attachSocketFor(broker),
    store,
    companionPath,
    worktreeOf: (id) => path.join(stateDir, "worktrees", id),
    home: WORKSET_HOME,
  });
  // Checked per turn: the broker holds the credential and may have none.
  const agent: StageAgent = {
    async turn(request) {
      if ((await client.info()).credential === null) {
        throw new StageError(
          "no Workset agent credential is configured; set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
        );
      }
      // A Workset may reach Ready without a session, so the turn spawns its container.
      await prepareWorkset(client, companionPath, request.worksetId, env);
      return harness.turn(request);
    },
  };

  const gitEnv = factoryGitEnv(env);
  const runner = new FactoryRunner({
    store,
    maxRuns: positive(env[FACTORY_MAX_RUNS_ENV], 2),
    stageMs: positive(env[FACTORY_STAGE_MINUTES_ENV], 60) * 60_000,
    depsFor: () => ({
      companionPath,
      stateDir,
      agent,
      // Publications commit too, so every command the runner starts carries the author.
      run: (command, args, cwd) => runCommand(command, args, { cwd, env: gitEnv }),
    }),
  });
  return { runner, store, companionPath };
}
