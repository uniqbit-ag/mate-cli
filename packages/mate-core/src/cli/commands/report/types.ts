export interface SpendingEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface SavingsEntry {
  tool: string;
  tokensSaved: number;
  calls: number;
  costSaved: number;
  efficiency: string;
}

export interface ToolStatus {
  name: string;
  enabled: boolean;
  status: string;
}

export interface ReportData {
  days: number;
  generatedAt: string;
  spending: SpendingEntry[];
  savings: SavingsEntry[];
  toolStatus: ToolStatus[];
  workingRepoPath: string;
  companionRepoPath: string;
  activeAgents: string[];
  enabledCapabilities: string[];
  totalSpending: number;
  totalSavings: number;
  netSpend: number;
}

export const REPORT_DOCUMENT_VERSION = 1 as const;

export type ReportValue = string | number | boolean | null;

export interface ReportKeyValue {
  label: string;
  value: ReportValue;
}

export interface ReportMetric {
  label: string;
  value: ReportValue;
  detail?: string;
}

export const REPORT_STATUS_TONES = ["ok", "warn", "error", "info", "neutral"] as const;

export type ReportStatusTone = (typeof REPORT_STATUS_TONES)[number];

export interface ReportStatus {
  label: string;
  status: string;
  detail?: string;
  /** Presentation tone; inferred from `status` when absent. */
  tone?: ReportStatusTone;
}

export interface ReportSectionBase {
  id: string;
  title: string;
}

export interface ReportMetadataSection extends ReportSectionBase {
  type: "metadata";
  items: ReportKeyValue[];
}

export interface ReportMetricsSection extends ReportSectionBase {
  type: "metrics";
  items: ReportMetric[];
}

export interface ReportKeyValueSection extends ReportSectionBase {
  type: "key-value";
  items: ReportKeyValue[];
}

export interface ReportTableSection extends ReportSectionBase {
  type: "table";
  columns: string[];
  rows: ReportValue[][];
}

export interface ReportStatusesSection extends ReportSectionBase {
  type: "statuses";
  items: ReportStatus[];
}

export const REPORT_TEXT_FORMATS = ["plain", "markdown"] as const;

export type ReportTextFormat = (typeof REPORT_TEXT_FORMATS)[number];

export interface ReportTextSection extends ReportSectionBase {
  type: "text";
  content: string;
  /** `plain` (default) keeps the text verbatim; `markdown` renders the safe subset. */
  format?: ReportTextFormat;
}

export interface ReportDiagramSectionBase extends ReportSectionBase {
  type: "diagram";
  /** Markdown note rendered beneath the visual. */
  caption?: string;
}

export interface ReportMermaidDiagramSection extends ReportDiagramSectionBase {
  mermaid: string;
  text?: never;
}

export interface ReportTextDiagramSection extends ReportDiagramSectionBase {
  text: string;
  mermaid?: never;
}

/** Exactly one payload: `mermaid` source drawn by the runtime, or `text` kept as a monospace block. */
export type ReportDiagramSection = ReportMermaidDiagramSection | ReportTextDiagramSection;

export interface ReportDiffSection extends ReportSectionBase {
  type: "diff";
  /** Unified diff as produced by `git diff`. */
  patch: string;
  /** Markdown note rendered beneath the visual. */
  caption?: string;
}

export type ReportSection =
  | ReportMetadataSection
  | ReportMetricsSection
  | ReportKeyValueSection
  | ReportTableSection
  | ReportStatusesSection
  | ReportTextSection
  | ReportDiagramSection
  | ReportDiffSection;

export interface ReportDocument {
  version: typeof REPORT_DOCUMENT_VERSION;
  title: string;
  generatedAt: string;
  period?: string;
  context?: string;
  metadata: ReportKeyValue[];
  summary: ReportMetric[];
  sections: ReportSection[];
}

export interface ReportOptions {
  days: number;
  json: boolean;
  input?: string;
}
