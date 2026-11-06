import { createServerFn } from "@tanstack/react-start";
import { COMPANION_DIGEST_PATTERN } from "@uniqbit/mate-core/studio";

import { packGraph } from "../lib/graph-wire";

/** The companion's spec graph, packed; Core rebuilds it only when its specs or archives change. */
export const getGraph = createServerFn({ method: "GET" })
  .validator((input: { companion: string }): { companion: string } => {
    if (typeof input?.companion !== "string" || !COMPANION_DIGEST_PATTERN.test(input.companion)) {
      throw new Error("no registered companion was selected");
    }
    return { companion: input.companion };
  })
  .handler(async ({ data, context }) => packGraph(await context.studio.graph(data.companion)));
