import { Box, render as inkRender } from "ink";
import React, { useEffect } from "react";
import { SelectMenu, type SelectMenuItem } from "../lib/components/select-menu";
import { WizardFooter } from "../lib/components/wizard-footer";
import { WizardHeader } from "../lib/components/wizard-header";
import type { CompanionMatch } from "../lib/orchestrator/companion-resolver";

export interface CompanionSelectorOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export const companionSelectorDeps = {
  render: inkRender,
};

function parseCompanionSelectorInput(input: string): "submit" | "cancel" | "up" | "down" | null {
  if (input === "\r" || input === "\n") return "submit";
  if (input === "\x1b[A" || input === "[A") return "up";
  if (input === "\x1b[B" || input === "[B") return "down";
  if (input === "\x1b" || input.toLowerCase() === "q") return "cancel";
  return null;
}

interface CompanionSelectorAppProps {
  items: SelectMenuItem[];
  activeIndex: number;
  onMounted?: () => void;
}

function CompanionSelectorApp({
  items,
  activeIndex,
  onMounted,
}: CompanionSelectorAppProps): React.JSX.Element {
  useEffect(() => {
    onMounted?.();
  }, [onMounted]);

  return (
    <Box flexDirection="column" width="100%">
      <WizardHeader title="Multiple companions link this repo — pick one" step={0} totalSteps={1} />
      <Box marginTop={1} flexDirection="column">
        <SelectMenu items={items} activeIndex={activeIndex} />
      </Box>
      <WizardFooter hint="↑↓ navigate · enter select · q cancel" />
    </Box>
  );
}

/**
 * Prompts the user to pick one companion when the active working repo is
 * linked from more than one companion's registry (`CompanionResolver`
 * reports this via `ambiguousMatches`, since only one companion may be
 * active for a repo at a time).
 */
export async function selectCompanion(
  matches: CompanionMatch[],
  options: CompanionSelectorOptions = {},
): Promise<CompanionMatch | null> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Companion selector requires a TTY.");
  }

  const items: SelectMenuItem[] = matches.map((match) => ({
    key: match.companionPath,
    label: match.companionPath,
    description: `(repo: ${match.repositoryId})`,
  }));

  let activeIndex = 0;
  let finalResult: CompanionMatch | null = null;
  let resolved = false;
  let rendered: ReturnType<typeof companionSelectorDeps.render> | undefined;

  stdin.resume();
  (stdin as NodeJS.ReadStream & { ref?: () => void }).ref?.();
  const keepAlive = setInterval(() => {}, 1 << 30);

  const cleanup = () => {
    clearInterval(keepAlive);
    stdin.off("data", onData);
    stdin.pause();
    stdin.setRawMode?.(false);
    (stdin as NodeJS.ReadStream & { unref?: () => void }).unref?.();
  };

  const rerender = () => {
    rendered?.rerender(
      <CompanionSelectorApp items={items} activeIndex={activeIndex} onMounted={onMounted} />,
    );
  };

  const onMounted = () => {
    stdin.on("data", onData);
  };

  const onData = (chunk: string) => {
    const action = parseCompanionSelectorInput(chunk);
    if (!action) return;
    if (action === "cancel") {
      finalResult = null;
      rendered?.unmount();
      return;
    }
    if (action === "up" || action === "down") {
      activeIndex = (activeIndex + (action === "up" ? -1 : 1) + items.length) % items.length;
      rerender();
      return;
    }
    if (action === "submit") {
      finalResult = matches[activeIndex] ?? null;
      rendered?.unmount();
    }
  };

  stdin.setEncoding("utf8");
  stdin.setRawMode?.(true);

  return new Promise<CompanionMatch | null>((resolve) => {
    rendered = companionSelectorDeps.render(
      <CompanionSelectorApp items={items} activeIndex={activeIndex} onMounted={onMounted} />,
      { stdin, stdout, stderr },
    );

    rendered.waitUntilExit().then(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(finalResult);
    });
  });
}
