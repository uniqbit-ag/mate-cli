import {
  type Query,
  queryOptions,
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { FrictionViewDays } from "@uniqbit/mate-core/studio";

import { getFriction, getFrictionRecording, setFrictionRecording } from "../server/friction";

export const DEFAULT_FRICTION_DAYS: FrictionViewDays = 30;

const SCOPE = "friction";

/** Every query holding the machine-wide switch; keys start with their owner. */
export const isFrictionQuery = (query: Query) => query.queryKey[1] === SCOPE;

/** Deliberately outside eager view prefetch, so opening Studio reads no log. */
export const frictionQuery = (companion: string, days: FrictionViewDays) =>
  queryOptions({
    queryKey: [companion, SCOPE, days] as const,
    queryFn: () => getFriction({ data: { companion, days } }),
    retry: false,
    refetchOnWindowFocus: false,
  });

/** The switch without a companion; "machine" can never equal a companion digest. */
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
  // Counted across pages: a change outlives the page that started it.
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
