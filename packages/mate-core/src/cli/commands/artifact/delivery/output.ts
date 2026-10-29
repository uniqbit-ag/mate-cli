import type { Delivery, UnscopedDelivery } from "../../../../lib/delivery/record";
import type { DeliveryRefusal } from "../../../../lib/delivery/record-delivery";

export interface CommandOutput {
  emitOut: (line: string) => void;
  emitErr: (line: string) => void;
  /** Writes `message`, when given, to stderr and sets a failing exit code. */
  refuse: (message?: string | null) => void;
}

export function commandOutput(deps: {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}): CommandOutput {
  const emitOut = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emitErr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  return {
    emitOut,
    emitErr,
    refuse: (message) => {
      if (message) emitErr(message);
      process.exitCode = 1;
    },
  };
}

/** One delivery as `<repository>  <branch or reason>  <merge>  <pr>`. */
export function renderDelivery(delivery: Delivery): string {
  if (delivery.notApplicable !== undefined) {
    return `  ${delivery.repository}  not applicable: ${delivery.notApplicable}`;
  }
  const branch = `${delivery.branch ?? "?"}${delivery.direct ? " [direct]" : ""}`;
  const merge = delivery.merge
    ? `${delivery.merge.state} (${delivery.merge.source})`
    : "no merge recorded";
  const pr = delivery.pr ? `  ${delivery.pr}` : "";
  return `  ${delivery.repository}  ${branch}  ${merge}${pr}`;
}

/** Wording for the refusals `link` and `archive` share; `unknown-change` names each command. */
export function sharedRefusalMessage(
  refusal: Exclude<DeliveryRefusal, { reason: "unknown-change" }>,
): string {
  if (refusal.reason === "no-repository") {
    return "mate: the Working Repository has no origin remote to identify it; pass --repository <org/repo>.";
  }
  if (refusal.reason === "protected-branch") {
    return `mate: ${refusal.branch} is a protected branch (${refusal.protection}); record it only as an explicit direct delivery with --direct.`;
  }
  return refusal.for === "pr"
    ? `mate: ${refusal.change} has no delivery branch for ${refusal.repository}; pass --branch first.`
    : `mate: ${refusal.change} has no delivery branch for ${refusal.repository} to confirm.`;
}

export function unscopedDeliveryWarning(change: string, entry: UnscopedDelivery): string {
  const hint = entry.closest ? `; did you mean ${entry.closest}?` : ".";
  return `warning: ${entry.repository} matches none of ${change}'s scopes${hint}`;
}
