/** Whether a key press belongs to a text field, so a page shortcut leaves it alone. */
export function inField(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']"),
  );
}
