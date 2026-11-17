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
 * @description Takes a submitted change into this checkout to revise it: fetches the pending
 * branch and writes the change's folder as it is there to `openspec/changes/<change>/`,
 * untracked, recorded as submitted from this checkout. `mate artifact submit <change>` then
 * pushes the revised folder again. Nothing is pushed and the pending branch is not changed.
 * @flags
 * - `--json` — emit a {@link TakeResult}.
 * @remarks Refused, exiting non-zero, when the checkout already holds a folder of that name or
 * the change is not submitted on the pending branch.
 */
export async function runArtifactTakeCommand(
  argv: string[],
  deps: TakeCommandDeps = {},
): Promise<void> {
  const { emitOut, refuse } = commandOutput(deps);
  const flags = parseFlags(argv, BOOLEAN_FLAGS);
  const [change, ...extra] = positionalArgs(argv, BOOLEAN_FLAGS);
  if (!change || extra.length > 0 || !isChangeName(change)) {
    return refuse("mate: artifact take requires one submitted change name.");
  }
  const environment = await resolveDeliveryEnvironment(deps);
  if ("error" in environment) return refuse(environment.error);
  const result: TakeResult = await (deps.take ?? takeSubmitted)(environment.companionPath, change);
  if (result.status === "refused") process.exitCode = 1;
  emitOut(flags.json === true ? JSON.stringify(result) : result.message);
}
