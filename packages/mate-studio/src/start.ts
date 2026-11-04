import { createStart } from "@tanstack/react-start";

/** Views render in the browser from data the first response carries (design D4). */
export const startInstance = createStart(() => ({
  defaultSsr: "data-only",
}));
