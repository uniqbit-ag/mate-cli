import { REPORT_VIEW_PREFIX } from "@uniqbit/mate-core/studio";

import type { Theme } from "../../stores/appearance";

/** A hosted report's address in the appearance chosen in Studio; no scheme when it follows the system. */
export function reportSrc(id: string, theme: Theme): string {
  const scheme = theme === "system" ? "" : `?scheme=${theme}`;
  return `${REPORT_VIEW_PREFIX}${id}${scheme}`;
}
