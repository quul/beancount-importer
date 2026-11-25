import type { AppConfig, AutomaticExclusionRule, BatchRevision, CnyRepaymentChoice, FundingMappingChoice, FundingMappingGroup, ImportPreview, LedgerError, ParsedAccount, ParsedTx, ReviewProblem, StatementName, StatementSource, TxDecision } from "../../src/shared/types.js";

export type ConfigResponse = AppConfig & { nativePathPicker?: boolean };
export type PathField = "ledgerRoot" | "pythonPath";

export interface BatchSummary extends BatchRevision {
  file: string;
  createdAt: number;
  committed: boolean;
  mergedInto?: string;
  mergedFrom?: string[];
  combinedFundingPending?: boolean;
  txCount: number;
}

export interface BatchMergeOptions {
  batches: BatchSummary[];
  sources: StatementSource[];
}

export interface UploadSummary {
  batchId: string;
  revision?: number;
  preview: Omit<ImportPreview, "txs"> & Pick<BatchSummary, "createdAt" | "revision" | "committed">;
}

export interface LedgerSummary {
  accountCount: number;
  txCount: number;
  accounts: ParsedAccount[];
  errors?: LedgerError[];
  loader?: string;
}

export interface GeneratedPreview {
  entries: string;
  monthFiles: Record<string, string>;
  targetFiles?: string[];
  generated: number;
  opens: string[];
  revision: number;
  errors?: string[];
}

export interface MergeDraft {
  date?: string;
  payee: string;
  narration: string;
}

export interface PdfPreview {
  file: string;
  screenshots: Array<{ page: number; image: string }>;
}

interface SavedDecisions {
  ok: boolean;
  revision: number;
  ready: number;
  reviewUndo?: ImportPreview["reviewUndo"];
  batch?: ImportPreview;
  changes?: { txs: ParsedTx[]; parseStats: NonNullable<ImportPreview["parseStats"]> };
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public temporary = false) { super(message); }
}

export class IncompleteReviewError extends ApiError {
  constructor(status: number, message: string, public problems: ReviewProblem[]) { super(status, message); }
}

async function json<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok && body !== undefined) return body as T;
  if (!response.ok && body && typeof body === "object") {
    const parsed = body as { code?: unknown; error?: unknown; details?: unknown; errors?: unknown; reviewProblems?: unknown };
    if (parsed.code === "review_incomplete" && typeof parsed.error === "string") {
      const problems = Array.isArray(parsed.reviewProblems) ? parsed.reviewProblems.filter((item): item is ReviewProblem =>
        item && typeof item.id === "string" && typeof item.message === "string"
        && (item.field === undefined || ["funding", "category", "postings", "tags", "settlement"].includes(item.field))) : [];
      throw new IncompleteReviewError(response.status, parsed.error, problems);
    }
    const describe = (detail: unknown): string => {
      if (typeof detail === "string") return detail;
      if (!detail || typeof detail !== "object") return "";
      const item = detail as { file?: unknown; line?: unknown; message?: unknown };
      if (typeof item.message !== "string") return "";
      const location = typeof item.file === "string" ? `${item.file}${typeof item.line === "number" ? `:${item.line}` : ""}` : "";
      return [location, item.message].filter(Boolean).join("：");
    };
    const reasons = [...new Set([
      typeof parsed.error === "string" ? parsed.error : "",
      ...(Array.isArray(parsed.details) ? parsed.details.map(describe) : [describe(parsed.details)]),
      ...(Array.isArray(parsed.errors) ? parsed.errors.map(describe) : [describe(parsed.errors)]),
    ].filter(Boolean))];
    if (reasons.length) throw new ApiError(response.status, reasons.join("\n"));
  }
  const temporary = response.ok || response.status >= 500;
  throw new ApiError(response.status, temporary ? "服务暂时不可用，请重试" : "请求未能完成，请刷新页面后重试", temporary);
}

function send<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, init).catch(() => { throw new ApiError(0, "服务连接中断，请重试", true); }).then(json<T>);
}

function post<T>(url: string, body: unknown): Promise<T> {
  return send<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export const api = {
  upload(files: File[]) {
    const body = new FormData();
    for (const file of files) body.append("files", file);
    return send<UploadSummary>("/api/upload", { method: "POST", body });
  },
  batches: (signal?: AbortSignal) => send<BatchSummary[]>("/api/batches", { signal }),
  exclusionRules: () => send<AutomaticExclusionRule[]>("/api/exclusion-rules"),
  batchMergeOptions: (batches: BatchRevision[]) => post<BatchMergeOptions>("/api/batches/merge-options", { batches }),
  mergeBatches: (batches: BatchRevision[], keepProgress: string[], names: StatementName[]) =>
    post<{ batch: ImportPreview & BatchRevision; batches: BatchSummary[] }>("/api/batches/merge", { batches, keepProgress, names }),
  renameStatements: (id: string, revision: number, names: StatementName[]) =>
    post<{ batch: ImportPreview }>("/api/batch/" + encodeURIComponent(id) + "/statement-names", { revision, names }),
  resolveReviewConflict: (id: string, revision: number, conflictId: string, sourceBatchId: string | null) =>
    post<{ batch: ImportPreview }>("/api/batch/" + encodeURIComponent(id) + "/review-conflicts", { revision, conflictId, sourceBatchId }),
  batch: (id: string) => send<ImportPreview>(`/api/batch/${encodeURIComponent(id)}`),
  cnyRepayments: (id: string, txId: string) =>
    send<CnyRepaymentChoice[]>(`/api/batch/${encodeURIComponent(id)}/cny-repayments/${encodeURIComponent(txId)}`),
  settleInCny: (id: string, revision: number, txId: string, amount: string, repaymentKey?: string) =>
    post<{ batch: ImportPreview }>(`/api/batch/${encodeURIComponent(id)}/cny-settlement`, { revision, id: txId, amount, repaymentKey }),
  pdfPreview: (id: string, txId: string, signal?: AbortSignal) =>
    send<PdfPreview>(`/api/batch/${encodeURIComponent(id)}/pdf-preview/${encodeURIComponent(txId)}`, { signal }),
  recheckLedger: (id: string, revision: number) => post<{ batch: ImportPreview; suspected: number }>(`/api/batch/${encodeURIComponent(id)}/recheck-ledger`, { revision }),
  excludeSuspected: (id: string, revision: number, reviewSessionId?: string) =>
    post<{ batch: ImportPreview; excluded: number }>(`/api/batch/${encodeURIComponent(id)}/exclude-suspected`, { revision, reviewSessionId }),
  undoReviewStatus: (id: string, revision: number, reviewSessionId: string) =>
    post<{ batch: ImportPreview; restoredIds: string[] }>(`/api/batch/${encodeURIComponent(id)}/undo-review-status`, { revision, reviewSessionId }),
  funding: (id: string, revision: number, mappings?: FundingMappingChoice[]) =>
    post<{ groups: FundingMappingGroup[]; batch?: ImportPreview; config?: ConfigResponse; skippedCombined?: number; batchRemoved?: boolean }>(
      `/api/batch/${encodeURIComponent(id)}/funding`, { revision, mappings }),
  saveFundingMapping: (batchId: string, revision: number, id: string, account: string) =>
    post<{ batch: ImportPreview; config: ConfigResponse; updated: number }>(
      `/api/batch/${encodeURIComponent(batchId)}/funding-mapping`, { revision, id, account },
    ),
  deleteBatch: (id: string, revision: number) => send<{ ok: true }>(`/api/batch/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision }),
  }),
  decide: (id: string, revision: number, decisions: TxDecision[], changesOnly = false, reviewSessionId?: string) => post<SavedDecisions>(
    `/api/batch/${encodeURIComponent(id)}/decide`, { revision, decisions, changesOnly: changesOnly || undefined, reviewSessionId }),
  merge: (id: string, revision: number, ids: string[], draft: MergeDraft) => post<{ batch: ImportPreview; mergedId: string }>(
    `/api/batch/${encodeURIComponent(id)}/merge`, { revision, ids, ...draft }),
  undoMerge: (id: string, revision: number, mergedId: string) => post<{ batch: ImportPreview }>(
    `/api/batch/${encodeURIComponent(id)}/undo-merge`, { revision, id: mergedId }),
  generate: (id: string, revision: number) => post<GeneratedPreview>(`/api/batch/${encodeURIComponent(id)}/generate`, { revision }),
  commit: (id: string, revision: number) => post<{ ok: boolean; written: string[]; opens?: string[]; alreadyCommitted?: boolean; validation?: unknown }>(`/api/batch/${encodeURIComponent(id)}/commit`, { revision }),
  ledger: () => send<LedgerSummary>("/api/ledger"),
  validate: () => send<{ available: boolean; ok: boolean; output: string }>("/api/validate"),
  fava: () => post<{ running: boolean; port: number; alreadyRunning?: boolean; error?: string }>("/api/fava", {}),
  config: () => send<ConfigResponse>("/api/config"),
  saveConfig: (config: Partial<AppConfig>) => post<ConfigResponse>("/api/config", config),
  pickPath: (kind: PathField, current: string, ledgerDirectory: string) => post<{ path: string | null }>("/api/config/pick-path", { kind, current, ledgerDirectory }),
};
