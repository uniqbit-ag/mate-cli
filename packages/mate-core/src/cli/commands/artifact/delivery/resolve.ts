import fs from "node:fs/promises";

import { isChangeName } from "../../../../lib/change-layout";
import {
  resolveSubmitted,
  type PartResolution,
  type ResolveResult,
} from "../../../../lib/delivery/staging/resolve";
import {
  type BooleanFlagSet,
  type CliFlags,
  parseFlags,
  positionalArgs,
} from "../../../parse-flags";
import { resolveDeliveryEnvironment, type DeliveryEnvironmentDeps } from "./environment";
import { commandOutput } from "./output";

export interface ResolveCommandDeps extends DeliveryEnvironmentDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  resolve?: typeof resolveSubmitted;
}

const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["json"]);

/** Every value of a repeatable value flag; null when one was given bare. */
function flagValues(value: CliFlags[string] | undefined): string[] | null {
  if (value === undefined) return [];
  if (typeof value === "boolean") return null;
  return Array.isArray(value) ? value : [value];
}

/**
 * @command mate artifact resolve <change>
 * @description Resolves a publication conflict on requirements changed on the default branch
 * since the submitted change's delta was written: rewrites each requirement's `MODIFIED` body
 * in the change's folder on the pending branch to the text in its `--file`, from any machine.
 * The commit sets the change's `specBase` to the fetched default tip and clears its `blocked`
 * entry, so publishing its Delivery Group again applies the resolved text. Pushed without force,
 * rebuilt up to three times; the checkout is not touched.
 * @flags
 * - `--capability <capability>` — the capability whose delta names the requirement.
 * - `--requirement <name>` — the requirement, as `conflict.requirement` in the publish result
 *   names it.
 * - `--file <path>` — the requirement's body as it should read, without its heading.
 * - `--json` — emit a {@link ResolveResult}.
 * @remarks The three value flags form one triple and repeat together, in order, once per
 * requirement. Refused, naming them in `unresolved`, while another requirement of the change
 * changed since its delta was written and is not resolved in the same call, and when a named
 * requirement changed again after the conflict was reported: publish again first. A requirement
 * removed on the default branch, or one the delta removes or only renames, is refused: the delta is
 * fixed and submitted again. Exits non-zero when nothing was resolved.
 */
export async function runArtifactResolveCommand(
  argv: string[],
  deps: ResolveCommandDeps = {},
): Promise<void> {
  const { emitOut, refuse } = commandOutput(deps);
  const flags = parseFlags(argv, BOOLEAN_FLAGS);
  const capabilities = flagValues(flags.capability);
  const requirements = flagValues(flags.requirement);
  const files = flagValues(flags.file);
  if (!capabilities || !requirements || !files) {
    return refuse("mate: --capability, --requirement and --file each take a value.");
  }
  const [change, ...extra] = positionalArgs(argv, BOOLEAN_FLAGS);
  if (!change || extra.length > 0 || !isChangeName(change)) {
    return refuse("mate: artifact resolve requires one submitted change name.");
  }
  if (
    capabilities.length === 0 ||
    capabilities.length !== requirements.length ||
    capabilities.length !== files.length
  ) {
    return refuse(
      "mate: artifact resolve requires --capability, --requirement and --file, once per requirement.",
    );
  }
  const parts: PartResolution[] = [];
  for (const [index, file] of files.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- few files, refused at the first unreadable one
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text === null || text.trim().length === 0) {
      return refuse(`mate: ${file} cannot be read or is empty.`);
    }
    parts.push({
      part: { capability: capabilities[index]!, requirement: requirements[index]! },
      text,
    });
  }

  const environment = await resolveDeliveryEnvironment(deps);
  if ("error" in environment) return refuse(environment.error);
  const resolve = deps.resolve ?? resolveSubmitted;
  const { companionPath, artifactType } = environment;
  const result: ResolveResult = await (artifactType
    ? resolve(companionPath, change, parts, { artifactType })
    : resolve(companionPath, change, parts));
  if (result.status === "refused") refuse(result.message);
  if (flags.json === true) emitOut(JSON.stringify(result));
  else if (result.status !== "refused") emitOut(result.message);
}
