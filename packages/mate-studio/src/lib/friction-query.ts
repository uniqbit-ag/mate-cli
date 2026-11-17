import { type Query, queryOptions } from "@tanstack/react-query";
import type { FrictionViewDays } from "@uniqbit/mate-core/studio";

import { getFriction } from "../server/friction";

export const DEFAULT_FRICTION_DAYS: FrictionViewDays = 30;

const SCOPE = "friction";

/** Every companion's friction query, for the machine-wide switch; keys start with the companion. */
export const isFrictionQuery = (query: Query) => query.queryKey[1] === SCOPE;

/** Deliberately outside eager view prefetch, so opening Studio reads no log. */
export const frictionQuery = (companion: string, days: FrictionViewDays) =>
  queryOptions({
    queryKey: [companion, SCOPE, days] as const,
    queryFn: () => getFriction({ data: { companion, days } }),
    retry: false,
    refetchOnWindowFocus: false,
  });
