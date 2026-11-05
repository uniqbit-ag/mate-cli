import { createServerFn } from "@tanstack/react-start";
import { COMPANION_DIGEST_PATTERN } from "@uniqbit/mate-core/studio";

import type { ReportSummary } from "../lib/studio-queries";

/** A registered companion's hosted reports, newest first; titles and times only. */
export const getReports = createServerFn({ method: "GET" })
  .validator((input: { companion: string }): { companion: string } => {
    if (typeof input?.companion !== "string" || !COMPANION_DIGEST_PATTERN.test(input.companion)) {
      throw new Error("no registered companion was selected");
    }
    return { companion: input.companion };
  })
  .handler(async ({ data, context }): Promise<ReportSummary[]> =>
    (await context.studio.reports(data.companion)).map(({ id, title, createdAt }) => ({
      id,
      title,
      createdAt,
    })),
  );
