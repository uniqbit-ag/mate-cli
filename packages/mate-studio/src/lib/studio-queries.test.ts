import { describe, expect, it } from "bun:test";
import { QueryClient, type QueryKey } from "@tanstack/react-query";

import type { ShellData } from "../server/shell";
import { agentCredentialKey } from "./agent-credential";
import {
  afterEvent,
  afterRefresh,
  afterVaultRefresh,
  afterVaultFileChange,
  companionViewQuery,
  factoryQuery,
  holdShellForMode,
  reportsQuery,
  shellQuery,
  vaultChildrenQuery,
  vaultQuery,
} from "./studio-queries";

const acme = "0123456789";
const acmeTwo = "9876543210";

/** Every held query of both companions, plus the agent credential, all fresh. */
function seeded() {
  const queryClient = new QueryClient();
  const held = (companion: string): Record<string, QueryKey> => ({
    shell: shellQuery({ companion }).queryKey,
    overview: companionViewQuery("dashboard", { companion }).queryKey,
    specs: companionViewQuery("specs", { companion, studioMode: "engineering" }).queryKey,
    factory: factoryQuery(companion).queryKey,
    reports: reportsQuery(companion).queryKey,
    vault: vaultQuery(companion, { path: "notes.md" }).queryKey,
    children: vaultChildrenQuery(companion, "docs").queryKey,
  });
  const keys = { acme: held(acme), acmeTwo: held(acmeTwo) };
  for (const key of [...Object.values(keys.acme), ...Object.values(keys.acmeTwo)]) {
    queryClient.setQueryData(key, "held");
  }
  queryClient.setQueryData(agentCredentialKey, "held");
  const stale = (key: QueryKey) => queryClient.getQueryState(key)?.isInvalidated ?? false;
  const staleNames = (companion: "acme" | "acmeTwo") =>
    Object.entries(keys[companion])
      .filter(([, key]) => stale(key))
      .map(([name]) => name);
  return { queryClient, stale, staleNames };
}

describe("afterEvent", () => {
  it("makes a board change stale for the companion's shell, views and Factory only", async () => {
    const { queryClient, stale, staleNames } = seeded();
    await afterEvent(queryClient, acme, "board");
    expect(staleNames("acme")).toEqual(["shell", "overview", "specs", "factory"]);
    expect(staleNames("acmeTwo")).toEqual([]);
    expect(stale(agentCredentialKey)).toBe(false);
  });

  it("makes a new report stale for the companion's Reports only", async () => {
    const { queryClient, staleNames } = seeded();
    await afterEvent(queryClient, acme, "reports");
    expect(staleNames("acme")).toEqual(["reports"]);
    expect(staleNames("acmeTwo")).toEqual([]);
  });

  it("leaves a vault tree change to the viewer", async () => {
    const { queryClient, staleNames } = seeded();
    await afterEvent(queryClient, acme, "vault-tree");
    expect(staleNames("acme")).toEqual([]);
  });
});

describe("afterRefresh", () => {
  it("makes only the selected companion and the agent credential stale", async () => {
    const { queryClient, stale, staleNames } = seeded();
    await afterRefresh(queryClient, acme);
    expect(staleNames("acme")).toEqual([
      "shell",
      "overview",
      "specs",
      "factory",
      "reports",
      "vault",
      "children",
    ]);
    expect(staleNames("acmeTwo")).toEqual([]);
    expect(stale(agentCredentialKey)).toBe(true);
  });
});

describe("afterVaultRefresh", () => {
  it("shows the refresh answer without refetching it, and makes the other vault reads stale", async () => {
    const { queryClient, stale, staleNames } = seeded();
    const shown = vaultQuery(acme, { path: "notes.md" }).queryKey;
    const fresh = "fresh" as never;
    await afterVaultRefresh(queryClient, acme, { path: "notes.md" }, fresh);
    expect(queryClient.getQueryData(shown)).toBe(fresh);
    expect(stale(shown)).toBe(false);
    expect(staleNames("acme")).toEqual(["children"]);
    expect(staleNames("acmeTwo")).toEqual([]);
  });
});

describe("afterVaultFileChange", () => {
  it("makes the companion's vault views stale, not its tree", async () => {
    const { queryClient, staleNames } = seeded();
    await afterVaultFileChange(queryClient, acme);
    expect(staleNames("acme")).toEqual(["vault"]);
  });
});

describe("holdShellForMode", () => {
  const shell = { studioMode: "engineering", metrics: null } as unknown as ShellData;
  const analysisKey = shellQuery({ companion: acme, studioMode: "analysis" }).queryKey;

  it("holds the other mode's shell, stale, so switching waits for nothing", () => {
    const queryClient = new QueryClient();
    holdShellForMode(queryClient, { companion: acme }, shell, "analysis");
    expect(queryClient.getQueryData<ShellData>(analysisKey)?.studioMode).toBe("analysis");
    expect(queryClient.getQueryState(analysisKey)?.dataUpdatedAt).toBe(0);
  });

  it("keeps a shell the server already sent", () => {
    const queryClient = new QueryClient();
    const served = { ...shell, studioMode: "analysis" } as ShellData;
    queryClient.setQueryData(analysisKey, served);
    holdShellForMode(queryClient, { companion: acme }, shell, "analysis");
    expect(queryClient.getQueryData(analysisKey)).toBe(served);
  });
});
