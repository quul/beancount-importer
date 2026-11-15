import type { AppConfig, ImportPreview, LedgerError, ParsedAccount, TxDecision } from "../../src/shared/types.js";

export interface BatchSummary {
  batchId: string;
  file: string;
  createdAt: number;
  revision: number;
  committed: boolean;
  txCount: number;
}

export interface UploadSummary {
  batchId: string;
  revision?: number;
  preview: Omit<ImportPreview, "txs">;
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
  generated: number;
  opens: string[];
  revision: number;
  errors?: string[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown; details?: unknown; errors?: unknown };
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
      message = reasons.length ? reasons.join("\n") : body;
    } catch { /* plain text response */ }
    throw new ApiError(response.status, message || `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(json<T>);
}

export const api = {
  upload(files: File[]) {
    const body = new FormData();
    for (const file of files) body.append("files", file);
    return fetch("/api/upload", { method: "POST", body }).then(json<UploadSummary>);
  },
  batches: () => fetch("/api/batches").then(json<BatchSummary[]>),
  batch: (id: string) => fetch(`/api/batch/${encodeURIComponent(id)}`).then(json<ImportPreview>),
  decide: (id: string, revision: number, decisions: TxDecision[]) => post<{ ok: boolean; revision: number; ready: number }>(`/api/batch/${encodeURIComponent(id)}/decide`, { revision, decisions }),
  generate: (id: string, revision: number) => post<GeneratedPreview>(`/api/batch/${encodeURIComponent(id)}/generate`, { revision }),
  commit: (id: string, revision: number) => post<{ ok: boolean; written: string[]; opens?: string[]; alreadyCommitted?: boolean; validation?: unknown }>(`/api/batch/${encodeURIComponent(id)}/commit`, { revision }),
  ledger: () => fetch("/api/ledger").then(json<LedgerSummary>),
  validate: () => fetch("/api/validate").then(json<{ available: boolean; ok: boolean; output: string }>),
  fava: () => post<{ running: boolean; port: number; alreadyRunning?: boolean; error?: string }>("/api/fava", {}),
  config: () => fetch("/api/config").then(json<AppConfig>),
  saveConfig: (config: Partial<AppConfig>) => post<AppConfig>("/api/config", config),
};
