import { createServerFn } from "@tanstack/react-start";

export const getGuide = createServerFn({ method: "GET" })
  .validator((input: { topic: string }) => ({ topic: String(input.topic) }))
  .handler(async ({ data }) => {
    const { guides } = await import("./guides.server");
    return Object.hasOwn(guides, data.topic) ? guides[data.topic]! : null;
  });
