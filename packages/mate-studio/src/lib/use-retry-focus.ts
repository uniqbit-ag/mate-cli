import { type RefObject, useEffect, useRef } from "react";

/**
 * A successful Retry removes itself; focus then goes to `target`, or without one to the control
 * `button` points at.
 */
export function useRetryFocus(isSuccess: boolean, target?: RefObject<HTMLElement | null>) {
  const button = useRef<HTMLButtonElement>(null);
  const retried = useRef(false);
  useEffect(() => {
    if (!isSuccess || !retried.current) return;
    retried.current = false;
    (target ?? button).current?.focus();
  }, [isSuccess, target]);
  return {
    button,
    retried: () => {
      retried.current = true;
    },
  };
}
