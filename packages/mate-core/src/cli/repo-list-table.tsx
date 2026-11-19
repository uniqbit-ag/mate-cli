/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Box, Text, render as inkRender } from "ink";
import React, { useEffect } from "react";

import type { CompanionListing, ConnectedCompanion } from "./commands/companion/list";
import type { LinkedRepository } from "../lib/orchestrator/types";

interface RenderCompanionListTableOptions {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

function columnWidth(header: string, values: string[]): number {
  return Math.max(header.length, ...values.map((value) => value.length));
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function useMounted(onMounted?: () => void): void {
  useEffect(() => {
    onMounted?.();
  }, [onMounted]);
}

function CompanionTable({
  companions,
  onMounted,
}: {
  companions: ConnectedCompanion[];
  onMounted?: () => void;
}): React.JSX.Element {
  useMounted(onMounted);

  const markerWidth = columnWidth(
    "Active",
    companions.map((companion) => (companion.active ? "*" : "")),
  );
  const pathWidth = columnWidth(
    "Path",
    companions.map((companion) => companion.path),
  );

  return (
    <Box flexDirection="column" width="100%">
      <Text bold>Connected companion</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {pad("Active", markerWidth)} {pad("Path", pathWidth)}
        </Text>
        {companions.map((companion) => (
          <Text key={companion.path} color={companion.active ? "green" : undefined}>
            {pad(companion.active ? "*" : "", markerWidth)} {pad(companion.path, pathWidth)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function RepositoryTable({
  repositories,
  onMounted,
}: {
  repositories: LinkedRepository[];
  onMounted?: () => void;
}): React.JSX.Element {
  useMounted(onMounted);

  const idWidth = columnWidth(
    "ID",
    repositories.map((repository) => repository.id),
  );
  const pathWidth = columnWidth(
    "Path",
    repositories.map((repository) => repository.path),
  );

  return (
    <Box flexDirection="column" width="100%">
      <Text bold>Linked repositories</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {pad("ID", idWidth)} {pad("Path", pathWidth)}
        </Text>
        {repositories.map((repository) => (
          <Text key={repository.id}>
            {pad(repository.id, idWidth)} {pad(repository.path, pathWidth)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/** The connected companions in a Working Repository, the linked repositories in a companion root. */
export function CompanionListTable({
  listing,
  onMounted,
}: {
  listing: CompanionListing;
  onMounted?: () => void;
}): React.JSX.Element {
  return "companions" in listing ? (
    <CompanionTable companions={listing.companions} onMounted={onMounted} />
  ) : (
    <RepositoryTable repositories={listing.repositories} onMounted={onMounted} />
  );
}

export async function renderCompanionListTable(
  listing: CompanionListing,
  options: RenderCompanionListTableOptions = {},
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  await new Promise<void>((resolve) => {
    let rendered: ReturnType<typeof inkRender> | undefined;

    const onMounted = () => {
      rendered?.unmount();
      resolve();
    };

    rendered = inkRender(<CompanionListTable listing={listing} onMounted={onMounted} />, {
      stdout,
      stderr,
    });
  });
}
