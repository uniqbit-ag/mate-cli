import { type RefObject, useEffect, useRef } from "react";

/**
 * Shows the dialog modally once, through `show`, and calls the latest `onClose` whenever it
 * closes. Close, Esc and the backdrop all end in the native close event.
 */
export function useModalDialog(
  onClose: () => void,
  show: (dialog: HTMLDialogElement) => void,
): RefObject<HTMLDialogElement | null> {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  const ref = useRef<HTMLDialogElement>(null);
  const showOnce = useRef(show);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) showOnce.current(dialog);
    // A click on the backdrop lands on the dialog itself, outside its content.
    const backdrop = (event: MouseEvent) => {
      if (event.target === dialog) dialog.close();
    };
    const closed = () => close.current();
    dialog.addEventListener("click", backdrop);
    dialog.addEventListener("close", closed);
    return () => {
      dialog.removeEventListener("click", backdrop);
      dialog.removeEventListener("close", closed);
    };
  }, []);
  return ref;
}
