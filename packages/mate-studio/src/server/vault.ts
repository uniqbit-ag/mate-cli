import { createServerFn } from "@tanstack/react-start";
import { COMPANION_DIGEST_PATTERN } from "@uniqbit/mate-core/studio";

const MAX_CONTENT = 5 * 1024 * 1024;

function companionOf(input: { companion?: unknown }): string {
  if (typeof input?.companion !== "string" || !COMPANION_DIGEST_PATTERN.test(input.companion)) {
    throw new Error("no registered companion was selected");
  }
  return input.companion;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : undefined;

interface VaultInput {
  companion: string;
  path?: string;
  dir?: string;
  refresh?: boolean;
  wait?: boolean;
}

/** The vault page; core resolves every path against the selected companion. */
export const getVault = createServerFn({ method: "GET" })
  .validator((input: VaultInput): VaultInput => ({
    companion: companionOf(input),
    path: text(input.path),
    dir: text(input.dir),
    refresh: input.refresh === true,
    wait: input.wait === true,
  }))
  .handler(({ data, context }) => {
    const { companion, ...request } = data;
    return context.studio.vault(companion, request);
  });

export const getVaultChildren = createServerFn({ method: "GET" })
  .validator((input: { companion: string; dir: string }) => {
    const dir = text(input.dir);
    if (!dir) throw new Error("the request names no folder");
    return { companion: companionOf(input), dir };
  })
  .handler(async ({ data, context }) => {
    const children = await context.studio.vaultChildren(data.companion, data.dir);
    if (!children) throw new Error("that folder is not in the listed tree");
    return children;
  });

export const getVaultMatches = createServerFn({ method: "GET" })
  .validator((input: { companion: string; query: string }) => ({
    companion: companionOf(input),
    query: typeof input.query === "string" ? input.query.slice(0, 200) : "",
  }))
  .handler(({ data, context }) => context.studio.vaultMatches(data.companion, data.query));

interface SaveInput {
  companion: string;
  path: string;
  content: string;
  token?: string;
}

/** A save; a stale token comes back as a conflict carrying the current content and token. */
export const saveVaultFile = createServerFn({ method: "POST" })
  .validator((input: SaveInput): SaveInput => {
    const path = text(input.path);
    if (!path) throw new Error("save requires a path");
    if (typeof input.content !== "string" || input.content.length > MAX_CONTENT) {
      throw new Error("save requires content within the size limit");
    }
    return {
      companion: companionOf(input),
      path,
      content: input.content,
      token: text(input.token),
    };
  })
  .handler(({ data, context }) =>
    context.studio.vaultSave(data.companion, data.path, data.content, data.token),
  );
