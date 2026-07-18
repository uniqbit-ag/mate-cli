export type RepoLinkParsedAction =
  | { action: "char"; char: string }
  | { action: "paste"; text: string }
  | { action: "backspace" }
  | { action: "submit" }
  | { action: "back" }
  | { action: "cancel" }
  | { action: "up" }
  | { action: "down" };

export function parseRepoLinkInput(
  input: string,
  mode: "text" | "select",
): RepoLinkParsedAction | null {
  if (input === "\x1b[A" || input === "[A") return mode === "select" ? { action: "up" } : null;
  if (input === "\x1b[B" || input === "[B") return mode === "select" ? { action: "down" } : null;
  if (input === "\x1b[D" || input === "[D") return { action: "back" };
  if (input === "\r" || input === "\n") return { action: "submit" };
  if (input === "\x1b" || input.toLowerCase() === "q") return { action: "cancel" };

  if (mode === "select") {
    return null;
  }

  // text mode
  if (input === "\x7f" || input === "\b") return { action: "backspace" };
  if (input.length === 1 && input >= " ") return { action: "char", char: input };
  if (input.length > 1) {
    // Ignore ANSI escape sequence fragments (e.g. "[A" from split arrow key sequences).
    if (/^\[[0-9;]*[A-Za-z~]$/.test(input)) return null;
    const printable = input
      .split("")
      .filter((c) => c >= " ")
      .join("");
    if (printable.length > 0) return { action: "paste", text: printable };
  }

  return null;
}
