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

export interface ReportOptions {
  days: number;
  json: boolean;
}
