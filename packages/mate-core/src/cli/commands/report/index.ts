import fs from "node:fs/promises";
import path from "node:path";

import { resolveFrameworkContext } from "../../../lib/orchestrator/framework-context";
import { ensureUnambiguousCompanion } from "../shared/companion-selection";
import {
  collectCcusageSpending,
  collectHeadroomSavings,
  collectRTKSavings,
  collectTokenSaveSavings,
  mergeResults,
} from "./collector";
import { renderJSON, renderMarkdown } from "./renderer";
import type { CollectorDeps } from "./collector";
import type { ReportData, ReportOptions } from "./types";

interface ReportCommandDeps extends CollectorDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveFrameworkContext?: typeof resolveFrameworkContext;
}

function parseOptions(argv: string[]): ReportOptions {
  let days = 7;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) {
      days = parseInt(argv[i + 1], 10);
      if (isNaN(days) || days < 1) days = 7;
      i++;
    }
    if (argv[i] === "--json") {
      json = true;
    }
  }

  return { days, json };
}

/**
 * @command mate report [--days N] [--json]
 * @description Generates a token usage report aggregating spending (via ccusage)
 * and savings (via TokenSave/Headroom), merged across working and companion repos.
 * Writes REPORT.md to companion repo by default. Use --json for machine-readable stdout.
 */
export async function runReportCommand(
  argv: string[] = [],
  deps: ReportCommandDeps = {},
): Promise<void> {
  const resolveCtx = deps.resolveFrameworkContext ?? resolveFrameworkContext;
  const ensureCompanion = deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion;
  const options = parseOptions(argv);

  if (!(await ensureCompanion(process.cwd()))) {
    process.exitCode = 1;
    return;
  }

  const { companionPath, configStore, workingRepoStore, repository, contextKind } =
    await resolveCtx(process.cwd());
  const config = await configStore.load();
  const working =
    repository || contextKind === "companion-root" ? null : await workingRepoStore.load();

  const workingRepoPath = repository?.path ?? working?.repos[0]?.path ?? process.cwd();
  const companionRepoPath = companionPath;
  const capabilities = config.capabilities ?? [];
  const enabledCapabilities = capabilities.map((c) => c.name);
  const activeAgents = process.env.MATE_ALLOWED_AGENTS
    ? process.env.MATE_ALLOWED_AGENTS.split(",")
        .map((a) => a.trim())
        .filter(Boolean)
    : [];

  const tokensaveEnabled = enabledCapabilities.includes("tokensave");
  const headroomEnabled = enabledCapabilities.includes("headroom");

  // Collect spending via ccusage (covers all agents: Claude, OpenCode, Codex, etc.)
  const ccusageResult = await collectCcusageSpending(options.days, deps);
  if (ccusageResult.friendlyError) {
    console.warn(ccusageResult.friendlyError);
  }

  // Collect savings in parallel
  let tokensaveWorking: Awaited<ReturnType<typeof collectTokenSaveSavings>> = {
    entry: null,
    status: { name: "tokensave (savings)", enabled: false, status: "not enabled" },
  };
  let tokensaveCompanion: Awaited<ReturnType<typeof collectTokenSaveSavings>> = {
    entry: null,
    status: { name: "tokensave (savings)", enabled: false, status: "not enabled" },
  };
  let rtkResult: Awaited<ReturnType<typeof collectRTKSavings>> = {
    entry: null,
    status: { name: "rtk", enabled: false, status: "not installed" },
  };
  let headroomResult: Awaited<ReturnType<typeof collectHeadroomSavings>> = {
    entry: null,
    status: { name: "headroom", enabled: false, status: "not enabled" },
  };

  if (tokensaveEnabled) {
    [tokensaveWorking, tokensaveCompanion] = await Promise.all([
      collectTokenSaveSavings(workingRepoPath, options.days, deps),
      collectTokenSaveSavings(companionRepoPath, options.days, deps),
    ]);
  }

  // RTK savings
  rtkResult = await collectRTKSavings(workingRepoPath, deps);

  if (headroomEnabled) {
    headroomResult = await collectHeadroomSavings(options.days, deps);
  }

  // Merge results
  const merged = mergeResults(
    ccusageResult.entries,
    tokensaveWorking.entry,
    tokensaveCompanion.entry,
    rtkResult.entry,
    headroomResult.entry,
  );

  const allToolStatus = [
    ccusageResult.status,
    tokensaveWorking.status,
    rtkResult.status,
    headroomResult.status,
  ];

  const reportData: ReportData = {
    days: options.days,
    generatedAt: new Date().toISOString(),
    workingRepoPath,
    companionRepoPath,
    activeAgents,
    enabledCapabilities,
    spending: merged.spending,
    savings: merged.savings,
    toolStatus: allToolStatus,
    totalSpending: merged.totalSpending,
    totalSavings: merged.totalSavings,
    netSpend: merged.netSpend,
  };

  if (options.json) {
    console.log(renderJSON(reportData));
    return;
  }

  const markdown = renderMarkdown(reportData);
  const reportPath = path.join(companionRepoPath, "REPORT.md");
  await fs.writeFile(reportPath, markdown);
  console.log(`Report written to ${reportPath}`);
}
