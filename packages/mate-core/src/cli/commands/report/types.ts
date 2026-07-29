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

export interface ReportStatus {
  label: string;
  status: string;
  detail?: string;
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

export interface ReportTextSection extends ReportSectionBase {
  type: "text";
  content: string;
}

export type ReportSection =
  | ReportMetadataSection
  | ReportMetricsSection
  | ReportKeyValueSection
  | ReportTableSection
  | ReportStatusesSection
  | ReportTextSection;

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
