import { queryOptions } from "@tanstack/react-query";

import { getVault } from "../../server/vault";

export interface VaultSearch {
  path?: string;
  dir?: string;
  mode?: "edit";
}

export const vaultQuery = (companion: string, search: VaultSearch, wait = false) =>
  queryOptions({
    queryKey: ["vault", companion, "view", search.path ?? null, search.dir ?? null, wait],
    queryFn: () => getVault({ data: { companion, path: search.path, dir: search.dir, wait } }),
  });
