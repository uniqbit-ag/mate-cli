import { useEffect, useRef } from "react";

/** A successful Retry removes itself; focus then goes to the control `button` points at. */
export function useRetryFocus(isSuccess: boolean) {
  const button = useRef<HTMLButtonElement>(null);
  const retried = useRef(false);
  useEffect(() => {
    if (!isSuccess || !retried.current) return;
    retried.current = false;
    button.current?.focus();
  }, [isSuccess]);
  return {
    button,
    retried: () => {
      retried.current = true;
    },
  };
}
