const fs = require("node:fs");
const path = require("node:path");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {}
  const companion = process.env.MATE_ARTIFACT_PATH || path.resolve(__dirname, "../../..");
  const archiveDir = path.join(companion, "openspec", "changes", "archive");
  const stateDir = path.join(companion, ".codex", "state");
  const session = String(input.session_id || "archive-snapshot").replace(/[^a-zA-Z0-9_-]/g, "_");
  const stateFile = path.join(stateDir, `mate-openspec-artifact-finish.${session}.json`);
  const pattern = /^\d{4}-\d{2}-\d{2}-.+$/;
  let current = [];
  try {
    current = fs
      .readdirSync(archiveDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {}
  let previous = null;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (state.version === 1 && Array.isArray(state.entries)) previous = new Set(state.entries);
  } catch {}
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, entries: current })}\n`);
  const commandSucceeded = () => {
    const candidates = [input, input.result, input.output, input.tool_output, input.tool_response];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      if (typeof candidate.success === "boolean") return candidate.success;
      for (const key of ["exitCode", "exit_code", "status", "statusCode", "status_code"]) {
        const value = candidate[key];
        if (typeof value === "number") return value === 0;
        if (typeof value === "string" && value.trim()) return Number(value) === 0;
      }
    }
    return true;
  };
  const command = String(input.tool_input?.command || input.tool_input?.cmd || input.command || "");
  if (/\bmate\s+artifact\s+finish\b/.test(command)) return;
  const direct = commandSucceeded()
    ? command.match(/\bopenspec\s+archive\s+(?:--\s+)?([^\s"']+)/)?.[1]
    : null;
  const newlyArchived = previous ? current.filter((entry) => !previous.has(entry)) : [];
  const changes = direct ? [direct] : newlyArchived.map((entry) => entry.slice(11));
  if (changes.length === 0) return;
  const message = changes
    .map(
      (change) =>
        `An openspec change (${change}) was just archived but not finished. Invoke the mate-openspec-artifact-finish skill now and use \`mate artifact finish\` to complete it.`,
    )
    .join("\n\n");
  process.stdout.write(JSON.stringify({ systemMessage: message }));
});
