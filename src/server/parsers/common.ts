/**
 * Common utilities for statement parsers.
 * Statement files are untrusted input: parsers only read text, never execute it.
 */

import fs from "node:fs";
import iconv from "iconv-lite";
import * as XLSX from "xlsx";
import crypto from "node:crypto";
import type { RawTx, SourceType } from "../../shared/types.js";
import { validDate } from "../../shared/postings.js";

export const UNREADABLE_TRANSACTION = "日期或金额无法解析";

export function isParsedStatementRow({ date, amount, excludedReason }: RawTx): boolean {
  return validDate(date) && Number.isFinite(amount) && excludedReason !== UNREADABLE_TRANSACTION;
}

export function txId(
  date: string,
  amount: number,
  direction: string,
  payee: string,
  identity: number | string,
  source = "unknown",
  sourceTxId?: string,
): string {
  const h = crypto
    .createHash("sha1")
    .update(sourceTxId ? [source, sourceTxId].join("|") : [source, date, amount.toFixed(2), direction, payee, typeof identity === "string" ? identity : ""].join("|"))
    .digest("hex");
  return h.slice(0, 24);
}

/** Read file as text trying GBK first (Chinese banks/Alipay default) then UTF-8. */
export function readTextSmart(buf: Buffer): string {
  // BOM → utf-8
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString("utf-8");
  }
  // try utf-8 strictly; if it fails, fall back to gbk
  const utf8 = buf.toString("utf-8");
  if (!utf8.includes("�")) return utf8;
  return iconv.decode(buf, "gbk");
}

export interface SheetData {
  /** rows of cells as strings */
  rows: string[][];
}

/** Parse CSV/TSV text into rows (handles quoted fields). */
export function parseCsv(text: string): string[][] {
  // Tabs in a comma-separated export are Excel's identifier suffixes, not columns.
  const delimiter = text.split(/\r?\n/).find((line) => line.includes("交易时间") || line.includes("交易日期"))?.includes(",")
    || text.split(/\r?\n/).some((line) => line.includes(",")) ? "," : "\t";
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      cur.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cur.push(field);
      field = "";
      if (cur.some((f) => f.trim() !== "")) rows.push(cur);
      cur = [];
    } else field += c;
  }
  if (field || cur.length) {
    cur.push(field);
    if (cur.some((f) => f.trim() !== "")) rows.push(cur);
  }
  return rows;
}

/** Read xlsx/xls/csv uniformly into rows of string cells. */
export function readSheet(file: string): SheetData {
  const buffer = fs.readFileSync(file);
  const ext = file.toLowerCase().split(".").pop();
  const excelSignature = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    || buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (ext === "xlsx" || ext === "xls" || excelSignature) {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: false,
      defval: "",
    });
    return { rows: rows.map((r) => (r as unknown[]).map((c) => String(c ?? ""))) };
  }
  const text = readTextSmart(buffer);
  return { rows: parseCsv(text) };
}

/** Find the header row index: first row containing all given keywords. */
export function findHeader(
  rows: string[][],
  keywords: string[],
): number {
  for (let i = 0; i < rows.length; i++) {
    const joined = rows[i].map((c) => c.trim()).join("|");
    if (keywords.every((k) => joined.includes(k))) return i;
  }
  return -1;
}

/** Column lookup by fuzzy name (exact contains, trimmed). */
export function col(
  header: string[],
  names: string[],
): number {
  for (const n of names) {
    const idx = header.findIndex((h) => h.trim() === n);
    if (idx >= 0) return idx;
  }
  for (const n of names) {
    const idx = header.findIndex((h) => h.trim().includes(n));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Normalize amount string: strip ¥, spaces, commas, ＋, keep sign. */
export function parseAmount(raw: string): number | null {
  const negative = /^[（(].*[）)]$/.test(raw.trim());
  const s = raw
    .replace(/[¥￥,，\s+＋]/g, "")
    .replace(/（-/g, "-")
    .replace(/[（）()]/g, "");
  if (!s || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -Math.abs(n) : n) : null;
}

/**
 * Parse date in the many formats Chinese statements use:
 * 2024-01-02, 2024/1/2, 2024.1.2, 2024年1月2日, 20240102, and with time suffix.
 */
export function parseDate(raw: string): { date: string; time?: string } | null {
  const s = raw.trim();
  let m = s.match(
    /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    const date = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date || Number(h ?? 0) > 23 || Number(mi ?? 0) > 59 || Number(se ?? 0) > 59) return null;
    return {
      date,
      time: h ? `${h.padStart(2, "0")}:${mi}:${se ?? "00"}` : undefined,
    };
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    return parseDate(`${m[1]}-${m[2]}-${m[3]}`);
  }
  // Excel serial date
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    const d = new Date(Math.round((n - 25569) * 86400 * 1000));
    return { date: d.toISOString().slice(0, 10) };
  }
  return null;
}

/** Payment methods can contain coupons with unknown value or explicit split tender. */
export function parseFundingParts(raw: string): { fundingParts?: RawTx["fundingParts"]; issues: string[] } {
  if (!raw || raw === "/" || raw === "-") return { issues: [] };
  const parts = raw.split(/\r?\n|[&＆+＋]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { issues: [] };
  const fundingParts = parts.map((part) => {
    const explicit = part.match(/(?:付款|支付)?[¥￥]\s*([\d,.]+)/);
    return { rawAccount: part.replace(/(?:付款|支付)?[¥￥]\s*[\d,.]+/, "").trim(), ...(explicit ? { amount: parseAmount(explicit[1]) ?? undefined } : {}) };
  });
  return { fundingParts, issues: fundingParts.some((part) => part.amount == null)
    ? ["组合支付，分摊待确认"] : ["组合支付，核对分录"] };
}

export interface ParseResult {
  source: SourceType;
  txs: RawTx[];
  errors: Array<{ row: number; message: string }>;
}
