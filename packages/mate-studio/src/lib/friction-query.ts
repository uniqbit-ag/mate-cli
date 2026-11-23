import {
  type Query,
  queryOptions,
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { FrictionMarkResult, FrictionViewDays } from "@uniqbit/mate-core/studio";

import {
  type FrictionMarkInput,
  getFriction,
  getFrictionRecording,
  markFriction,
  setFrictionRecording,
} from "../server/friction";

export const DEFAULT_FRICTION_DAYS: FrictionViewDays = 30;

const SCOPE = "friction";

export const isFrictionQuery = (query: Query) => query.queryKey[1] === SCOPE;

export const frictionQuery = (companion: string, days: FrictionViewDays) =>
  queryOptions({
    queryKey: [companion, SCOPE, days] as const,
    queryFn: () => getFriction({ data: { companion, days } }),
    retry: false,
    refetchOnWindowFocus: false,
  });

export const frictionRecordingQuery = queryOptions({
  queryKey: ["machine", SCOPE, "recording"] as const,
  queryFn: () => getFrictionRecording(),
  retry: false,
  refetchOnWindowFocus: false,
});

export interface RecordingToggle {
  pending: boolean;
  error?: string;
  onChange: (recording: boolean) => void;
}

const RECORDING_CHANGE = [SCOPE, "set-recording"] as const;

export function useSetFrictionRecording(): RecordingToggle {
  const client = useQueryClient();
  const pending = useIsMutating({ mutationKey: RECORDING_CHANGE }) > 0;
  const change = useMutation({
    mutationKey: RECORDING_CHANGE,
    mutationFn: (recording: boolean) => setFrictionRecording({ data: { recording } }),
    onSuccess: async ({ recording }) => {
      // Invalidating would keep a running first read, which may predate this change.
      await client.cancelQueries({ predicate: isFrictionQuery });
      client.setQueriesData<{ recording: boolean }>(
        { predicate: isFrictionQuery },
        (held) => held && { ...held, recording },
      );
      return client.invalidateQueries({ predicate: isFrictionQuery });
    },
  });
  return {
    pending,
    error: change.isError
      ? `Recording could not be turned ${change.variables ? "on" : "off"}: ${change.error.message}`
      : undefined,
    onChange: (recording) => change.mutate(recording),
  };
}

/**
 * Marks one item; resolves once every friction query was refetched, so the caller sees the
 * list without a marked item. A refusal resolves too and changes no query.
 */
export type MarkFriction = (mark: FrictionMarkInput) => Promise<FrictionMarkResult>;

export function useMarkFriction(): MarkFriction {
  const client = useQueryClient();
  const change = useMutation({
    mutationKey: [SCOPE, "mark"] as const,
    mutationFn: (mark: FrictionMarkInput) => markFriction({ data: mark }),
    onSuccess: async (result) => {
      if (!result.ok) return;
      await client.cancelQueries({ predicate: isFrictionQuery });
      await client.invalidateQueries({ predicate: isFrictionQuery });
    },
  });
  return change.mutateAsync;
}
