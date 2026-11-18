import type { RecordingToggle } from "../lib/friction-query";
import { Button } from "./ui/button";
import { StatusWord } from "./view-parts";

/** One id is enough: the start page and the Friction view are never shown together. */
const REACH = "friction-recording-reach";

export function RecordingState({ recording }: { recording: boolean }) {
  return (
    <StatusWord marker={recording ? "build" : "idle"}>
      Recording is {recording ? "on" : "off"}
    </StatusWord>
  );
}

export function RecordingReach() {
  return (
    <p id={REACH} className="m-0 text-xs text-muted">
      Applies to all companions on the machine that runs Studio.
    </p>
  );
}

/** With `recording` unknown, the button is disabled and claims neither state. */
export function RecordingButton({
  recording,
  toggle,
}: {
  recording: boolean | undefined;
  toggle: RecordingToggle;
}) {
  return (
    <Button
      size="sm"
      variant={recording === false ? "primary" : "default"}
      disabled={recording === undefined || toggle.pending}
      aria-describedby={REACH}
      onClick={() => toggle.onChange(!recording)}
    >
      {recording === undefined
        ? "Turn recording on or off"
        : `Turn recording ${recording ? "off" : "on"}`}
    </Button>
  );
}
