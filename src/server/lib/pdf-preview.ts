import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { hasPdfSource, type ParsedTx, type RawTx } from "../../shared/types.js";
import { parsePdfBank, renderPdfRegions } from "../parsers/pdf.js";
import type { StoredBatch } from "./batches.js";
import { ImportError } from "./commit.js";

const storedPdfName = /^[a-f0-9]{32}\.pdf$/;
const normalizedPayee = (value: string) => value.normalize("NFKC").replace(/\s/g, "");

export function createPdfPreviewLoader(uploads: string, maxBytes: number) {
  const recoveredFiles = new Map<string, string>();
  const recoveredRows = new Map<string, Promise<RawTx[]>>();

  async function readMatchingFile(name: string, hash: string) {
    if (!storedPdfName.test(name)) return undefined;
    const file = path.join(uploads, name);
    try {
      const entry = await lstat(file);
      if (!entry.isFile() || entry.size > maxBytes) return undefined;
      const data = await readFile(file);
      return createHash("sha256").update(data).digest("hex") === hash ? { file, data } : undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EBUSY") return undefined;
      throw error;
    }
  }

  async function locateFile(hash: string, storedName?: string) {
    const knownName = recoveredFiles.get(hash) ?? storedName;
    if (knownName) {
      const match = await readMatchingFile(knownName, hash);
      if (match) return match;
    }
    // Batches created before previews retained only the original file digest.
    for (const entry of await readdir(uploads, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === knownName) continue;
      const match = await readMatchingFile(entry.name, hash);
      if (match) {
        recoveredFiles.set(hash, entry.name);
        return match;
      }
    }
    return undefined;
  }

  async function recoverRegions(file: string, data: Uint8Array, tx: ParsedTx) {
    const key = `${tx.source}:${tx.sourceFileHash}`;
    let pending = recoveredRows.get(key);
    if (!pending) {
      pending = parsePdfBank(file, tx.source, undefined, data).then(({ txs }) => txs);
      if (recoveredRows.size >= 8) recoveredRows.delete(recoveredRows.keys().next().value!);
      recoveredRows.set(key, pending);
    }
    const rows = await pending;
    const sourceRow = rows.find((row) => row.row === tx.row && row.date === tx.date && row.time === tx.time
      && row.amount === tx.amount && row.direction === tx.direction && row.currency === tx.currency
      && normalizedPayee(row.payee) === normalizedPayee(tx.payee));
    if (!sourceRow?.pdfRegions?.length) recoveredRows.delete(key);
    return sourceRow?.pdfRegions;
  }

  return async (batch: StoredBatch, tx: ParsedTx) => {
    if (!hasPdfSource(tx)) throw new ImportError(404, "这笔交易没有可查看的 PDF 原文。");
    const hash = tx.sourceFileHash!;
    const original = await locateFile(hash, batch.pdfUploads?.[hash]);
    if (!original) throw new ImportError(404, "找不到最初上传的 PDF。请重新上传原账单。");
    const regions = tx.pdfRegions?.length ? tx.pdfRegions : await recoverRegions(original.file, original.data, tx);
    if (!regions?.length) throw new ImportError(422, "无法定位这笔交易在 PDF 中的位置。请重新上传原账单。");
    try {
      const screenshots = await renderPdfRegions(original.data, regions);
      if (screenshots.length === regions.length) return { file: tx.sourceFile, screenshots };
    } catch (error) {
      console.error("Could not render PDF source preview", error);
    }
    throw new ImportError(500, "暂时无法显示 PDF 原文截图。请重试。");
  };
}
