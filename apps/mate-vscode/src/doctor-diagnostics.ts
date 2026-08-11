import * as vscode from "vscode";

import { type DoctorReport, InvalidDoctorResponseError, parseDoctorReport } from "./doctor-schema";
import type { MateCliClientOptions, MateCliResult } from "./mate-cli-client";

/** URI scheme for workspace-scoped findings with no natural file target (e.g. a missing global tool). */
export const MATE_DOCTOR_URI_SCHEME = "mate-doctor";
export const MATE_DOCTOR_URI = vscode.Uri.parse(`${MATE_DOCTOR_URI_SCHEME}:/Mate Doctor`);

export interface DoctorFinding {
  message: string;
  severity: vscode.DiagnosticSeverity;
  /** Absolute path when the finding concerns a specific file/directory; absent means workspace-scoped. */
  filePath?: string;
}

/** Maps a parsed {@link DoctorReport} into flat findings — some file-scoped, most workspace-scoped, matching the real contract's shape. */
export function collectDoctorFindings(report: DoctorReport): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  for (const failure of report.resolutionFailures) {
    findings.push({
      message: `Companion at ${failure.companionPath}: ${failure.message}`,
      severity: vscode.DiagnosticSeverity.Error,
      filePath: failure.companionPath,
    });
  }

  for (const member of report.hubMembers) {
    if (member.commitStatus === "missing" || !member.exists) {
      findings.push({
        message: `Hub member "${member.id}" is missing at ${member.path}.`,
        severity: vscode.DiagnosticSeverity.Error,
        filePath: member.path,
      });
    } else if (member.commitStatus === "drifted") {
      findings.push({
        message: `Hub member "${member.id}" has drifted from its materialized commit.`,
        severity: vscode.DiagnosticSeverity.Warning,
        filePath: member.path,
      });
    }
  }

  if (report.multipleCompanions.length > 1) {
    findings.push({
      message: `This working repository is linked from ${report.multipleCompanions.length} companions; commands that don't prompt for a choice may pick one arbitrarily.`,
      severity: vscode.DiagnosticSeverity.Warning,
    });
  }

  if (report.policyError) {
    findings.push({ message: report.policyError, severity: vscode.DiagnosticSeverity.Warning });
  }

  for (const tool of report.toolInstallations) {
    if (tool.status === "missing") {
      findings.push({
        message: `Required tool "${tool.tool}" was not found.`,
        severity: vscode.DiagnosticSeverity.Warning,
      });
    }
  }

  for (const drift of report.requiredPluginDrift) {
    findings.push({
      message: `Required plugin "${drift.pluginId}": ${drift.reason}`,
      severity: vscode.DiagnosticSeverity.Warning,
    });
  }

  if (report.engineRequirement && !report.engineRequirement.ok) {
    findings.push({
      message: report.engineRequirement.detail || "Engine version requirement not satisfied.",
      severity: vscode.DiagnosticSeverity.Warning,
    });
  }

  return findings;
}

function findingsToDiagnostics(findings: DoctorFinding[]): Map<string, vscode.Diagnostic[]> {
  const zeroRange = new vscode.Range(0, 0, 0, 0);
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const finding of findings) {
    const uriKey = finding.filePath
      ? vscode.Uri.file(finding.filePath).toString()
      : MATE_DOCTOR_URI.toString();
    const diagnostic = new vscode.Diagnostic(zeroRange, finding.message, finding.severity);
    diagnostic.source = "Mate Doctor";
    const existing = byUri.get(uriKey);
    if (existing) existing.push(diagnostic);
    else byUri.set(uriKey, [diagnostic]);
  }
  return byUri;
}

export interface DoctorDiagnosticsDeps {
  runMateCli: (args: string[], options: MateCliClientOptions) => Promise<MateCliResult>;
  options: () => MateCliClientOptions;
}

/**
 * Owns the `mate-doctor` diagnostic collection and the virtual document
 * backing workspace-scoped findings. Read-only: never repairs, never
 * mutates a registry — a click on a diagnostic navigates at most.
 */
export class DoctorDiagnostics implements vscode.TextDocumentContentProvider {
  private readonly collection: vscode.DiagnosticCollection;

  constructor(private readonly deps: DoctorDiagnosticsDeps) {
    this.collection = vscode.languages.createDiagnosticCollection("mate");
  }

  provideTextDocumentContent(): string {
    return "Workspace-scoped Mate Doctor findings are listed in the Problems panel.";
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.collection,
      vscode.workspace.registerTextDocumentContentProvider(MATE_DOCTOR_URI_SCHEME, this),
    );
  }

  /** Re-runs `mate doctor --json` and replaces the collection wholesale — no incremental diffing. */
  async refresh(): Promise<void> {
    let report: DoctorReport;
    try {
      const result = await this.deps.runMateCli(["doctor", "--json"], this.deps.options());
      if (result.code !== 0) {
        this.collection.clear();
        return;
      }
      report = parseDoctorReport(result.stdout);
    } catch (error) {
      // Unavailable mate / malformed doctor output degrades to "no diagnostics"
      // rather than a modal error — tree-item tooltips remain the primary surface.
      if (error instanceof InvalidDoctorResponseError) this.collection.clear();
      return;
    }

    const findings = collectDoctorFindings(report);
    this.collection.clear();
    if (findings.length === 0) return;
    for (const [uri, diagnostics] of findingsToDiagnostics(findings)) {
      this.collection.set(vscode.Uri.parse(uri), diagnostics);
    }
  }

  dispose(): void {
    this.collection.dispose();
  }
}
