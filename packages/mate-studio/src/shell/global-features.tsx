import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  RecordingButton,
  RecordingReach,
  RecordingState,
  useRetryFocus,
} from "../components/friction-recording";
import { Button } from "../components/ui/button";
import { ListCard } from "../components/view-parts";
import { frictionRecordingQuery, useSetFrictionRecording } from "../lib/friction-query";
import { useBrowser } from "../lib/use-browser";

function RecordingRow({
  status,
  note,
  action,
}: {
  status?: ReactNode;
  note: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="grid min-w-0 flex-[1_1_16rem] gap-0.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <b className="text-sm font-semibold">Friction recording</b>
          {status}
        </div>
        {note}
      </div>
      {action}
    </div>
  );
}

export function GlobalFeatures() {
  const query = useQuery({ ...frictionRecordingQuery, enabled: useBrowser() });
  const toggle = useSetFrictionRecording();
  const { button: recordingButton, retried } = useRetryFocus(query.isSuccess);
  const recording = query.data?.recording;
  return (
    <ListCard title="Global features">
      {/* Checked first: a failed reload leaves older data that is no longer a known state. */}
      {query.isError ? (
        <RecordingRow
          note={
            <p className="m-0 text-xs text-bad" role="alert">
              The recording state could not be read.
            </p>
          }
          action={
            <Button
              size="sm"
              disabled={query.isFetching}
              onClick={() => {
                retried();
                void query.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : (
        <RecordingRow
          status={
            recording === undefined ? (
              <span className="text-xs text-muted">Checking…</span>
            ) : (
              <RecordingState recording={recording} />
            )
          }
          note={<RecordingReach />}
          action={<RecordingButton ref={recordingButton} recording={recording} toggle={toggle} />}
        />
      )}
      {toggle.error ? (
        <p
          className="m-0 border-t border-rule-soft px-4 py-2 text-sm wrap-anywhere text-bad"
          role="alert"
        >
          {toggle.error}
        </p>
      ) : null}
    </ListCard>
  );
}
