import { queryOptions } from "@tanstack/react-query";

import { getFactory } from "../server/factory";

export const factoryQuery = (companion: string) =>
  queryOptions({
    queryKey: ["factory", companion],
    queryFn: () => getFactory({ data: { companion } }),
    // Events update the board in place; this only covers a missed one (design D7).
    refetchInterval: 30_000,
  });
