import { createServerFn } from "@tanstack/react-start";
import {
  COMPANION_DIGEST_PATTERN,
  type CompanionAddInput,
  type CompanionAddResult,
} from "@uniqbit/mate-core/studio";

/** Deletes a registered companion's folder and unregisters it; core refuses unless writable. */
export const deleteCompanion = createServerFn({ method: "POST" })
  .validator((input: { companion: string }) => {
    if (typeof input?.companion !== "string" || !COMPANION_DIGEST_PATTERN.test(input.companion)) {
      throw new Error("no registered companion was named");
    }
    return { companion: input.companion };
  })
  .handler(({ data, context }) => context.studio.deleteCompanion(data.companion));

/** Adds a companion by Git URL or absolute path; a refusal comes back as an answer with its reason. */
export const addCompanion = createServerFn({ method: "POST" })
  .validator((input: CompanionAddInput): CompanionAddInput => {
    if (input?.kind === "url" && typeof input.url === "string") {
      return { kind: "url", url: input.url };
    }
    if (input?.kind === "path" && typeof input.path === "string") {
      return { kind: "path", path: input.path };
    }
    throw new Error("name a Git URL or a path");
  })
  .handler(({ data, context }): Promise<CompanionAddResult> => context.studio.addCompanion(data));
