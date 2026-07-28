const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }
  const repo = process.env.MATE_REPO_PATH || process.cwd();
  const companion = process.env.MATE_ARTIFACT_PATH;
  if (!companion) process.exit(0);
  const artifact = (value) => {
    const normalized = `/${value.replaceAll("\\", "/").replace(/^\/+/, "")}`;
    const basename = path.basename(value);
    return (
      [
        "CLAUDE.md",
        "CONTEXT.md",
        "design.md",
        "explore-brief.md",
        "proposal.md",
        "spec.md",
        "tasks.md",
      ].includes(basename) ||
      [
        "/changes/",
        "/openspec/",
        "/specs/",
        "/docs/adr/",
        "/docs/adrs/",
        "/docs/decisions/",
        "/docs/prd/",
      ].some((part) => normalized.includes(part)) ||
      (basename.endsWith(".md") && basename !== "README.md")
    );
  };
  const targets = [];
  const tool = input.tool_name || input.toolName || input.tool;
  const toolInput = input.tool_input || input.toolInput || {};
  if (["Write", "Edit", "MultiEdit"].includes(tool))
    targets.push(toolInput.file_path || toolInput.filePath || "");
  if (["Bash", "exec_command"].includes(tool)) {
    const command = String(toolInput.command || toolInput.cmd || input.command || "");
    for (const match of command.matchAll(
      />{1,2}\s*([^\s;|&<>]+\.md)\b|\btee\s+(?:-a\s+)?([^\s;|&<>]+\.md)\b/g,
    )) {
      targets.push((match[1] || match[2]).replace(/^['"]|['"]$/g, ""));
    }
  }
  if (tool === "apply_patch") {
    const patchText = String(toolInput.patch || toolInput.input || "");
    for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm))
      targets.push(match[1].trim());
  }
  for (const target of targets.filter(Boolean)) {
    const absolute = path.isAbsolute(target) ? path.normalize(target) : path.resolve(repo, target);
    if (
      absolute === path.normalize(companion) ||
      absolute.startsWith(`${path.normalize(companion)}${path.sep}`) ||
      !artifact(target)
    )
      continue;
    const relative = path.relative(repo, absolute);
    const isUnderRepo =
      relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    let productDocumentation = false;
    if (isUnderRepo) {
      const parts = relative.split(path.sep);
      productDocumentation = parts.some((part) => part === ".storybook" || part === "storybook");
      for (let index = 0; !productDocumentation && index < parts.length; index += 1) {
        if (parts[index] !== "docs") continue;
        const docsRoot = path.join(repo, ...parts.slice(0, index + 1));
        productDocumentation = fs.existsSync(path.join(docsRoot, "package.json"));
      }
    }
    if (productDocumentation) continue;
    const ignored =
      spawnSync("git", ["-C", repo, "check-ignore", "--no-index", "-q", "--", relative]).status ===
      0;
    const tracked =
      spawnSync("git", ["-C", repo, "ls-files", "--error-unmatch", "--", relative]).status === 0;
    if (!ignored && !tracked) {
      process.stderr.write(
        `Mate guardrail: artifact writes must go to the companion framework path.\n target: ${target}\n companion: ${companion}\n`,
      );
      process.exit(2);
    }
  }
});
