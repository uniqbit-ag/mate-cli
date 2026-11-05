/**
 * The progress screen live on the terminal, if any. Code deep inside a phase
 * (setup plugins, prompts, installers) reports through here instead of writing
 * to the terminal behind the spinner's back.
 */
export interface LiveProgressHook {
  /** Prints a warning as a log line above the live line. */
  warn(message: string): void;
  /** Called before a prompt or an inherited-stdio child takes the terminal. */
  releaseTerminal(): void;
}

let live: LiveProgressHook | undefined;

/** Routes a warning to the live progress screen, or to stderr when none is live. */
export function emitWarning(message: string): void {
  if (live) {
    live.warn(message);
    return;
  }
  process.stderr.write(`${message}\n`);
}

/** Clears the spinner before a prompt or child process writes to the terminal. */
export function releaseTerminal(): void {
  live?.releaseTerminal();
}

/** Makes `hook` the live progress until the returned restore runs. */
export function installLiveProgress(hook: LiveProgressHook): () => void {
  const previous = live;
  live = hook;
  return () => {
    if (live === hook) live = previous;
  };
}
