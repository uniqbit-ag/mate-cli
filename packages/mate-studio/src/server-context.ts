import type { StudioRequestContext } from "@uniqbit/mate-core/studio";
import type { getRouter } from "./router";
import type { startInstance } from "./start";

declare module "@tanstack/react-start" {
  interface Register {
    router: ReturnType<typeof getRouter>;
    config: Awaited<ReturnType<typeof startInstance.getOptions>>;
    server: { requestContext: StudioRequestContext };
  }
}
