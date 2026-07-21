import { useEffect, useState } from "react";

export const SPINNER_FRAMES = ["·", "✦", "✧", "✦"];
export const SPINNER_INTERVAL_MS = 120;

export function useSpinnerFrame(active: boolean, intervalMs: number = SPINNER_INTERVAL_MS): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => setFrame((value) => (value + 1) % SPINNER_FRAMES.length),
      intervalMs,
    );
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return SPINNER_FRAMES[frame];
}
