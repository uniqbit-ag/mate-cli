import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { registeredCompanion, shellQuery } from "../lib/queries";
import { type VaultSearch, vaultQuery } from "../views/vault/vault-query";
import { VaultLayout } from "../views/vault/vault-view";

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

export const Route = createFileRoute("/vault")({
  staticData: { view: "vault" },
  // Forgiving like the server's parsing: an unknown mode is read.
  validateSearch: (raw: { path?: unknown; dir?: unknown; mode?: unknown }): VaultSearch => ({
    ...(text(raw.path) ? { path: text(raw.path) } : {}),
    ...(text(raw.dir) ? { dir: text(raw.dir) } : {}),
    ...(raw.mode === "edit" ? { mode: "edit" as const } : {}),
  }),
  loaderDeps: ({ search }) => ({
    companion: search.companion,
    role: search.role,
    path: search.path,
    dir: search.dir,
  }),
  loader: async ({ context, deps }) => {
    const companion = await registeredCompanion(context.queryClient, deps);
    return companion ? context.queryClient.ensureQueryData(vaultQuery(companion, deps)) : null;
  },
  component: VaultRoute,
});

function VaultRoute() {
  const search = Route.useSearch();
  const { data: shell } = useSuspenseQuery(
    shellQuery({ companion: search.companion, role: search.role }),
  );
  if (!search.companion || !shell.selected) return null;
  const rootName = shell.selected.path.split(/[\\/]/).findLast(Boolean) ?? "companion";
  return (
    <VaultLayout
      companion={search.companion}
      rootName={rootName}
      writable={shell.writable}
      search={{ path: search.path, dir: search.dir, mode: search.mode }}
    />
  );
}
