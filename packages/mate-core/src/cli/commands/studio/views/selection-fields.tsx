/** @jsxImportSource hono/jsx */

import { type StudioSelection, toFields } from "../selection";

/** The hidden fields of a control's GET form: the whole selection it leads to. */
export function SelectionFields({ selection }: { selection: StudioSelection }) {
  return (
    <>
      {toFields(selection).map(({ name, value }) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}
