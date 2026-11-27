import { isChangeName } from "../../../../lib/change-layout";
import { takeSubmitted, type TakeResult } from "../../../../lib/delivery/staging/submit";
import { type BooleanFlagSet, parseFlags, positionalArgs } from "../../../parse-flags";
import { resolveDeliveryEnvironment, type DeliveryEnvironmentDeps } from "./environment";
import { commandOutput } from "./output";

export interface TakeCommandDeps extends DeliveryEnvironmentDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  take?: typeof takeSubmitted;
}

const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["json"]);

/**
 * @command mate artifact take <change>
 * @description Takes a change from the pending branch into this checkout: a submitted one to
 * revise it, or one Studio's Work shared to continue it. Fetches the pending branch and writes
 * the change's folder as it is there to `openspec/changes/<change>/`, untracked, recorded as
 * pushed from this checkout. `mate artifact submit <change>` then pushes the revised folder
 * again. Nothing is pushed and the pending branch is not changed.
 * @flags
 * - `--json` — emit a {@link TakeResult}.
 * @remarks Refused, exiting non-zero, when the checkout holds a folder of that name changed
 * since this checkout last pushed or took it (an unchanged one is replaced), or the pending
 * branch does not hold the change.
 */
export async function runArtifactTakeCommand(
  argv: string[],
  deps: TakeCommandDeps = {},
): Promise<void> {
  const { emitOut, refuse } = commandOutput(deps);
  const flags = parseFlags(argv, BOOLEAN_FLAGS);
  const [change, ...extra] = positionalArgs(argv, BOOLEAN_FLAGS);
  if (!change || extra.length > 0 || !isChangeName(change)) {
    return refuse("mate: artifact take requires one change name.");
  }
  const environment = await resolveDeliveryEnvironment(deps);
  if ("error" in environment) return refuse(environment.error);
  const take = deps.take ?? takeSubmitted;
  const { companionPath, artifactType } = environment;
  const result: TakeResult = await (artifactType
    ? take(companionPath, change, { artifactType })
    : take(companionPath, change));
  if (result.status === "refused") process.exitCode = 1;
  emitOut(flags.json === true ? JSON.stringify(result) : result.message);
}
