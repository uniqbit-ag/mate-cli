import { Box, Text, render as inkRender } from "ink";
import React, { useEffect } from "react";

import type { LinkedRepository } from "../lib/orchestrator/types";

interface RepoListTableProps {
  repositories: LinkedRepository[];
  activeRepositoryId?: string;
  onMounted?: () => void;
}

interface RenderRepoListTableOptions {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

function columnWidth(header: string, values: string[]): number {
  return Math.max(header.length, ...values.map((value) => value.length));
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function RepoListTable({
  repositories,
  activeRepositoryId,
  onMounted,
}: RepoListTableProps): React.JSX.Element {
  useEffect(() => {
    onMounted?.();
  }, [onMounted]);

  const markerWidth = columnWidth(
    "Active",
    repositories.map((repository) => (repository.id === activeRepositoryId ? "*" : "")),
  );
  const idWidth = columnWidth(
    "ID",
    repositories.map((repository) => repository.id),
  );
  const profileWidth = columnWidth(
    "Profile",
    repositories.map((repository) => repository.profile),
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
          {pad("Active", markerWidth)} {pad("ID", idWidth)} {pad("Profile", profileWidth)}{" "}
          {pad("Path", pathWidth)}
        </Text>
        {repositories.map((repository) => {
          const isActive = repository.id === activeRepositoryId;
          const marker = isActive ? "*" : "";

          return (
            <Text key={repository.id} color={isActive ? "green" : undefined}>
              {pad(marker, markerWidth)} {pad(repository.id, idWidth)}{" "}
              {pad(repository.profile, profileWidth)} {pad(repository.path, pathWidth)}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

export async function renderRepoListTable(
  repositories: LinkedRepository[],
  activeRepositoryId: string | undefined,
  options: RenderRepoListTableOptions = {},
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  await new Promise<void>((resolve) => {
    let rendered: ReturnType<typeof inkRender> | undefined;

    const onMounted = () => {
      rendered?.unmount();
      resolve();
    };

    rendered = inkRender(
      <RepoListTable
        repositories={repositories}
        activeRepositoryId={activeRepositoryId}
        onMounted={onMounted}
      />,
      { stdout, stderr },
    );
  });
}
