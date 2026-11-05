import { createServerFn } from "@tanstack/react-start";
import { COMPANION_DIGEST_PATTERN, type SkillAgent } from "@uniqbit/mate-core/studio";

const AGENTS: ReadonlySet<string> = new Set(["claude", "opencode", "agents"]);

interface SkillPreviewInput {
  companion: string;
  agent: SkillAgent;
  name: string;
  file?: string;
}

/** One installed skill's files and one of them rendered; core confines it to the skill's folder. */
export const getSkillPreview = createServerFn({ method: "GET" })
  .validator((input: SkillPreviewInput): SkillPreviewInput => {
    if (typeof input?.companion !== "string" || !COMPANION_DIGEST_PATTERN.test(input.companion)) {
      throw new Error("no registered companion was selected");
    }
    if (!AGENTS.has(input.agent)) throw new Error("unknown agent");
    if (typeof input.name !== "string" || input.name === "" || input.name.length > 200) {
      throw new Error("the request names no skill");
    }
    const file =
      typeof input.file === "string" && input.file !== "" && input.file.length <= 4096
        ? input.file
        : undefined;
    return { companion: input.companion, agent: input.agent, name: input.name, file };
  })
  .handler(({ data, context }) =>
    context.studio.skillPreview(data.companion, data.agent, data.name, data.file),
  );
