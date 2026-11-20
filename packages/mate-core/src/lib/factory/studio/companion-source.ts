import type { CompanionSourceResult, StudioCompanionSource } from "../../../tools/setup/service";
import { checkedCloneUrl } from "../clone-url";
import type { FactoryClient } from "../client";
import { gitKeyOf } from "../git-credential-store";
import { FactoryError } from "../ids";

/**
 * Companions by Git URL: the broker clones them into the factory's companions directory. A
 * local path or file URL is refused before the broker is asked; a refusal for authentication
 * names the Git token that would unlock the URL.
 */
export function factoryCompanionSource(
  client: Pick<FactoryClient, "cloneCompanion">,
  folder: string,
): StudioCompanionSource {
  return {
    folder,
    async addByUrl(rawUrl: string): Promise<CompanionSourceResult> {
      try {
        const cloned = await client.cloneCompanion(checkedCloneUrl(rawUrl).url);
        return { ok: true, path: cloned.path, existing: cloned.existing };
      } catch (error) {
        if (!(error instanceof FactoryError)) throw error;
        const key = error.code === "auth" ? gitKeyOf(rawUrl.trim()) : null;
        return {
          ok: false,
          reason: error.message,
          ...(key ? { tokenKey: `${key.host}/${key.org}` } : {}),
        };
      }
    },
  };
}
