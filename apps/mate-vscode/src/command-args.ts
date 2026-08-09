import type { WorkspaceInventoryPairing } from "./schema";
import type { MateTreeNode } from "./tree-model";

/**
 * Every pairing command is invoked either from a tree item's `command`
 * (arguments: [node]) or a `view/item/context` menu entry, both of which
 * VS Code invokes with the resolved tree element as the first argument.
 */
export function pairingFromCommandArg(arg: unknown): WorkspaceInventoryPairing | undefined {
  if (arg && typeof arg === "object" && (arg as MateTreeNode).kind === "pairing") {
    return (arg as { pairing: WorkspaceInventoryPairing }).pairing;
  }
  return undefined;
}
