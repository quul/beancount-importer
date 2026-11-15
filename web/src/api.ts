import type { AppConfig, ImportPreview, ParsedTx } from "../../../src/shared/types.js";

export interface UploadSummary {
  batchId: string;
  preview: {
    file: string;
    source: string;
    txCount: number;
    dedup: { crossSourceDuplicates: number; ledgerDuplicates: number; transferPairs?: number };
    lowConfidence: number;
    errors: Array<{ row: number; message: string }>;
    accountsDetected: Array<{ raw: string; guess: string; txCount: number }>;
  };
}

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
  return resp.json() as Promise<T>;
}

export const api = {
  upload: (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    return fetch("/api/upload", { method: "POST", body: fd }).then(json<UploadSummary>);
  },
  batch: (id: string) =>
    fetch(`/api/batch/${id}`).then(json<ImportPreview>),
  decide: (
    id: string,
    decisions: Array<{ id: string; account?: string; funding?: string; status?: string }>,
  ) =>
    fetch(`/api/batch/${id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decisions }),
    }).then(json<{ ok: boolean; ready: number }>),
  generate: (id: string) =>
    fetch(`/api/batch/${id}/generate`, { method: "POST" }).then(
      json<{ entries: string; monthFiles: Record<string, string>; generated: number; opens: string[] }>,
    ),
  commit: (id: string, monthFiles: Record<string, string>, opens: string[]) =>
    fetch(`/api/batch/${id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ monthFiles, opens }),
    }).then(json<{ ok: boolean; written: string[] }>,
    ),
  ledger: () =>
    fetch("/api/ledger").then(
      json<{ accountCount: number; txCount: number; accounts: Array<{ account: string }> }>,
    ),
  validate: () =>
    fetch("/api/validate").then(
      json<{ available: boolean; ok: boolean; output: string }>,
    ),
  fava: () =>
    fetch("/api/fava", { method: "POST" }).then(
      json<{ running: boolean; port: number; alreadyRunning?: boolean; error?: string }>,
    ),
  config: () => fetch("/api/config").then(json<AppConfig>()),
};
