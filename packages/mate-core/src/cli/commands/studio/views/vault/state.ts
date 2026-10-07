import type { StudioVaultSelection } from "../../selection";
import type { VaultManager, VaultTreeResult } from "../../vault";
import type { StudioVaultPage } from "../model";

export async function vaultState(
  manager: VaultManager,
  companionPath: string,
  sel: StudioVaultSelection,
  options: { tree: "prefetch" | "await" },
): Promise<StudioVaultPage> {
  let tree: VaultTreeResult | null = null;
  let failure: string | null = null;
  try {
    tree =
      options.tree === "prefetch"
        ? await manager.prefetch(companionPath, sel.refresh)
        : await manager.tree(companionPath, sel.refresh);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  let open: StudioVaultPage["open"] = null;
  let refusal: string | null = null;
  if (sel.openPath) {
    try {
      open = await manager.open(companionPath, sel.openPath);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    tree: tree?.tree ?? null,
    open,
    refusal,
    incoming: null,
    overwritten: null,
    watching: tree?.watching ?? false,
    warning: tree?.warning ?? null,
    failure,
    generation: tree?.generation ?? null,
  };
}
