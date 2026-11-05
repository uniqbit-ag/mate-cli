import { createServerFn } from "@tanstack/react-start";
import { COMPANION_DIGEST_PATTERN } from "@uniqbit/mate-core/studio";

/** Deletes a registered companion's folder and unregisters it; core refuses unless writable. */
export const deleteCompanion = createServerFn({ method: "POST" })
  .validator((input: { companion: string }) => {
    if (typeof input?.companion !== "string" || !COMPANION_DIGEST_PATTERN.test(input.companion)) {
      throw new Error("no registered companion was named");
    }
    return { companion: input.companion };
  })
  .handler(({ data, context }) => context.studio.deleteCompanion(data.companion));
