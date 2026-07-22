import readline from "node:readline";
import { Box, Text, render as inkRender } from "ink";
import { useEffect } from "react";

import { WizardFooter } from "./wizard-footer";

interface ConfirmPromptAppProps {
  question: string;
  yesSelected: boolean;
  onMounted?: () => void;
}

export function ConfirmPromptApp({ question, yesSelected, onMounted }: ConfirmPromptAppProps) {
  useEffect(() => {
    onMounted?.();
  }, [onMounted]);

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" width="100%">
        <Text bold>{question}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={yesSelected ? "cyan" : undefined}>{yesSelected ? "▸" : " "} Yes</Text>
        <Box marginLeft={3}>
          <Text color={!yesSelected ? "cyan" : undefined}>{!yesSelected ? "▸" : " "} No</Text>
        </Box>
      </Box>
      <WizardFooter hint="y yes · n no · ← → navigate · enter confirm · q cancel" />
    </Box>
  );
}

export interface ConfirmPromptDeps {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  render?: typeof inkRender;
}

export function confirmPrompt(question: string, deps: ConfirmPromptDeps = {}): Promise<boolean> {
  const stdin = deps.stdin ?? (process.stdin as NodeJS.ReadStream);
  const stdout = deps.stdout ?? (process.stdout as NodeJS.WriteStream);
  const stderr = deps.stderr ?? (process.stderr as NodeJS.WriteStream);
  const renderFn = deps.render ?? inkRender;

  if (!stdin.isTTY) {
    // CI should never try to prompt on the ambient process stdin.
    if (process.env.CI && deps.stdin === undefined) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      stderr.write(question);

      if (!stdin.readable) {
        resolve(false);
        return;
      }

      stdin.resume();
      (stdin as NodeJS.ReadStream & { ref?: () => void }).ref?.();

      const rl = readline.createInterface({
        input: stdin,
        terminal: false,
      });

      let settled = false;

      const cleanup = () => {
        stdin.off("end", onEnd);
        stdin.off("error", onError);
        rl.off("close", onClose);
        rl.close();
      };

      const settle = (result: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const onEnd = () => settle(false);
      const onError = () => settle(false);
      const onClose = () => settle(false);

      rl.once("line", (answer) => settle(answer.trim().toLowerCase() === "y"));
      rl.once("close", onClose);
      stdin.once("end", onEnd);
      stdin.once("error", onError);
    });
  }

  return new Promise((resolve) => {
    let yesSelected = false;
    let settled = false;
    let rendered!: ReturnType<typeof renderFn>;

    const cleanup = () => {
      rendered.unmount();
      stdin.off("data", onData);
      stdin.pause();
      stdin.setRawMode?.(false);
      (stdin as NodeJS.ReadStream & { unref?: () => void }).unref?.();
      clearInterval(keepAlive);
    };

    const doResolve = (result: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const rerender = (nextYesSelected: boolean) => {
      yesSelected = nextYesSelected;
      rendered.rerender(
        <ConfirmPromptApp question={question} yesSelected={yesSelected} onMounted={onMounted} />,
      );
    };

    const onData = (chunk: string) => {
      if (chunk === "y" || chunk === "Y") {
        doResolve(true);
      } else if (chunk === "n" || chunk === "N" || chunk === "q" || chunk === "Q") {
        doResolve(false);
      } else if (chunk === "\r" || chunk === "\n") {
        doResolve(yesSelected);
      } else if (
        chunk === "\x1b[C" ||
        chunk === "\x1b[D" ||
        chunk === "\x1b[A" ||
        chunk === "\x1b[B" ||
        chunk === "[C" ||
        chunk === "[D" ||
        chunk === "[A" ||
        chunk === "[B"
      ) {
        rerender(!yesSelected);
      } else if (chunk === "\x1b") {
        doResolve(false);
      }
    };

    stdin.setEncoding("utf8");
    stdin.resume();
    (stdin as NodeJS.ReadStream & { ref?: () => void }).ref?.();
    stdin.setRawMode?.(true);

    const keepAlive = setInterval(() => {}, 1 << 30);

    const onMounted = () => {
      stdin.read();
      stdin.on("data", onData);
    };

    rendered = renderFn(
      <ConfirmPromptApp question={question} yesSelected={yesSelected} onMounted={onMounted} />,
      { stdin, stdout, stderr },
    );

    rendered.waitUntilExit().then(() => {
      if (!settled) {
        doResolve(false);
      }
    });
  });
}
