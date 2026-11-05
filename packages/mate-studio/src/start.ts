import { createStart } from "@tanstack/react-start";

/**
 * Views render in the browser from data the first response carries (design D4); the read-only
 * companion views opt into `ssr: true`, so a direct open is drawn with the document.
 */
export const startInstance = createStart(() => ({
  defaultSsr: "data-only",
}));
